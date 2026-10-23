import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import {
  AppProvider,
  Page,
  Card,
  Select,
  Button,
  BlockStack,
  Text,
  DataTable,
  Banner,
  InlineStack,
  Box,
} from "@shopify/polaris";
import esTranslations from "@shopify/polaris/locales/es.json";

import { useState } from "react";
import { authenticate } from "../shopify.server";
import { calculateProductScore } from "../services/sorter";

// --- LOADER: Carga las colecciones de la tienda ---
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    #graphql
    query getCollections {
      collections(first: 50) {
        nodes {
          id
          title
          productsCount {
            count
          }
        }
      }
    }
  `);

  const responseJson = await response.json();
  return { collections: responseJson.data.collections.nodes || [] };
};

// Variable temporal en memoria para respaldar el orden original antes de reordenar
let lastBackupOrder: { collectionId: string; moves: { id: string; newPosition: string }[] } | null = null;

// --- ACTION: Maneja Previsualización, Aplicación y Restauración ---
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const collectionId = formData.get("collectionId") as string;

  if (!collectionId) {
    return { success: false, error: "Selecciona una colección válida" };
  }

  // --- RESTAURAR ORDEN ANTERIOR ---
  if (intent === "restore") {
    if (!lastBackupOrder || lastBackupOrder.collectionId !== collectionId) {
      return { success: false, error: "No hay un respaldo previo para esta colección" };
    }

    await admin.graphql(
      `
      #graphql
      mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id }
          userErrors { field message }
        }
      }
    `,
      { variables: { id: collectionId, moves: lastBackupOrder.moves } }
    );

    return { success: true, intent: "restore" };
  }

  // 1. Obtener Ventas de los últimos 30 días (Órdenes pagadas)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateQuery = `created_at:>=${thirtyDaysAgo.toISOString().split("T")[0]} AND financial_status:paid`;

  const salesMap: Record<string, number> = {};

  try {
    const ordersResponse = await admin.graphql(
      `
      #graphql
      query getRecentSales($query: String!) {
        orders(first: 250, query: $query) {
          nodes {
            lineItems(first: 50) {
              nodes {
                product {
                  id
                }
                quantity
              }
            }
          }
        }
      }
    `,
      { variables: { query: dateQuery } }
    );

    const ordersData = await ordersResponse.json();
    const orders = ordersData.data?.orders?.nodes || [];

    orders.forEach((order: any) => {
      order.lineItems.nodes.forEach((item: any) => {
        if (item.product?.id) {
          const pId = item.product.id;
          salesMap[pId] = (salesMap[pId] || 0) + item.quantity;
        }
      });
    });
  } catch (err) {
    console.error("Error consultando órdenes:", err);
  }

  // 2. Obtener productos de la colección seleccionada
  const productsResponse = await admin.graphql(
    `
    #graphql
    query getCollectionProducts($id: ID!) {
      collection(id: $id) {
        title
        products(first: 250) {
          nodes {
            id
            title
            variants(first: 50) {
              nodes {
                price
                compareAtPrice
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  `,
    { variables: { id: collectionId } }
  );

  const productsData = await productsResponse.json();
  const collectionTitle = productsData.data?.collection?.title || "";
  const rawProducts = productsData.data?.collection?.products?.nodes || [];

  // Guardar el orden original actual como respaldo antes de reordenar
  const originalMoves = rawProducts.map((p: any, index: number) => ({
    id: p.id,
    newPosition: index.toString(),
  }));

  // 3. Procesar y calcular Score por producto
  const processedProducts = rawProducts.map((p: any) => {
    let maxDisc = 0;
    let inStockVariants = 0;

    p.variants.nodes.forEach((v: any) => {
      const price = parseFloat(v.price || "0");
      const compareAtPrice = parseFloat(v.compareAtPrice || "0");

      if (compareAtPrice > price) {
        const disc = ((compareAtPrice - price) / compareAtPrice) * 100;
        if (disc > maxDisc) maxDisc = disc;
      }
      if (v.inventoryQuantity > 0) {
        inStockVariants++;
      }
    });

    const sales30d = salesMap[p.id] || 0;

    const score = calculateProductScore({
      id: p.id,
      discPct: Math.round(maxDisc),
      tallas: inStockVariants,
      ventas30d: sales30d,
    });

    return {
      id: p.id,
      title: p.title,
      discPct: Math.round(maxDisc),
      tallas: inStockVariants,
      ventas30d: sales30d,
      score: Number(score.toFixed(2)),
    };
  });

  // Ordenar de mayor a menor score
  processedProducts.sort((a: any, b: any) => b.score - a.score);

  if (intent === "preview") {
    return {
      success: true,
      intent: "preview",
      collectionTitle,
      collectionId,
      products: processedProducts,
    };
  }

  if (intent === "apply") {
    // Guardar copia de respaldo en memoria antes de hacer la mutación
    lastBackupOrder = {
      collectionId,
      moves: originalMoves,
    };

    const moves = processedProducts.map((p: any, index: number) => ({
      id: p.id,
      newPosition: index.toString(),
    }));

    if (moves.length > 0) {
      await admin.graphql(
        `
        #graphql
        mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            job { id }
            userErrors { field message }
          }
        }
      `,
        { variables: { id: collectionId, moves } }
      );
    }

    return {
      success: true,
      intent: "apply",
      collectionTitle,
      count: moves.length,
      hasBackup: true,
    };
  }

  return { success: false, error: "Acción no reconocida" };
};

// --- COMPONENTE VISUAL ---
export default function Index() {
  const { collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [selectedCollection, setSelectedCollection] = useState("");
  const submit = useSubmit();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

  const options = collections.map((c: any) => ({
    label: `${c.title} (${c.productsCount?.count ?? 0} productos)`,
    value: c.id,
  }));

  const handlePreview = () => {
    if (!selectedCollection) return;
    submit(
      { intent: "preview", collectionId: selectedCollection },
      { method: "post" }
    );
  };

  const handleApply = () => {
    const targetCollection = actionData?.collectionId || selectedCollection;
    if (!targetCollection) return;
    submit(
      { intent: "apply", collectionId: targetCollection },
      { method: "post" }
    );
  };

  const handleRestore = () => {
    const targetCollection = actionData?.collectionId || selectedCollection;
    if (!targetCollection) return;
    submit(
      { intent: "restore", collectionId: targetCollection },
      { method: "post" }
    );
  };

  const tableRows =
    actionData?.intent === "preview" && actionData?.products
      ? actionData.products.map((p: any, idx: number) => [
          `${idx + 1}°`,
          p.title,
          `${p.discPct}%`,
          p.tallas,
          p.ventas30d,
          p.score,
        ])
      : [];

  return (
    <AppProvider i18n={esTranslations}>
      <Page title="Ordenamiento de Colecciones">
        <BlockStack gap="500">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Algoritmo de Ordenamiento (40% Descuento · 30% Stock · 30% Ventas 30d)
              </Text>
              <Select
                label="Selecciona una colección"
                options={[{ label: "Selecciona...", value: "" }, ...options]}
                onChange={setSelectedCollection}
                value={selectedCollection}
              />
              <InlineStack gap="300">
                <Button
                  onClick={handlePreview}
                  loading={isSubmitting && actionData?.intent === "preview"}
                  disabled={!selectedCollection}
                >
                  Calcular y Previsualizar
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          {actionData?.intent === "apply" && actionData?.success && (
            <Banner title="¡Colección reordenada con éxito!" tone="success">
              <BlockStack gap="300">
                <p>
                  Se aplicó el nuevo orden a <strong>{actionData.count}</strong> productos en
                  la colección <strong>{actionData.collectionTitle}</strong>.
                </p>
                <InlineStack>
                  <Button onClick={handleRestore} loading={isSubmitting}>
                    Restaurar Orden Anterior
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          )}

          {actionData?.intent === "restore" && actionData?.success && (
            <Banner title="Orden restaurado" tone="info">
              <p>Se ha vuelto a aplicar el orden original que tenía la colección antes de la reordenación.</p>
            </Banner>
          )}

          {actionData?.intent === "preview" && actionData?.products && (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h3" variant="headingMd">
                    Previsualización del nuevo orden ({actionData.collectionTitle})
                  </Text>
                  <Button
                    variant="primary"
                    onClick={handleApply}
                    loading={isSubmitting}
                  >
                    Aprobar y Aplicar en Shopify
                  </Button>
                </InlineStack>

                <Box paddingBlockEnd="200">
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                    ]}
                    headings={[
                      "Pos.",
                      "Producto",
                      "Max Dto.",
                      "Tallas Stock",
                      "Ventas (30d)",
                      "Score",
                    ]}
                    rows={tableRows}
                  />
                </Box>
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Page>
    </AppProvider>
  );
}