import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import { store } from "@/store";
import App from "@/App";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import "@/styles/index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Élément racine #root introuvable.");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </Provider>
  </React.StrictMode>,
);
