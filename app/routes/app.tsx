import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { AppProvider } from "@shopify/polaris";
import esTranslations from "@shopify/polaris/locales/es.json";
import { authenticate } from "../shopify.server";
import styles from "../app.css?url"; // Importamos el CSS local con Vite

export const links = () => [{ rel: "stylesheet", href: styles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider i18n={esTranslations}>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Application Error:", error);

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>Ha ocurrido un error inesperado</h1>
      <p>Revisa la consola del servidor para más detalles.</p>
    </div>
  );
}

export const headers: HeadersFunction = ({ loaderHeaders }) => {
  return loaderHeaders;
};