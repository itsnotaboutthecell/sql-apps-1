import { entraVerifier } from './auth.js';
import { loadRuntimeConfig, portFromEnvironment } from './config.js';
import { createGateway } from './gateway.js';

const config = loadRuntimeConfig(process.env);
const app = await createGateway(config, {
  verifyUser: entraVerifier(config.tenantId, config.apiClientId),
  fetch,
});
await app.listen({ port: portFromEnvironment(process.env.PORT), host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}