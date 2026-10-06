import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
buildApp({ config }).listen(config.PORT, () => {
  console.log(`MedRekk backend listening on :${config.PORT} (auth=${config.AUTH_MODE})`);
});
