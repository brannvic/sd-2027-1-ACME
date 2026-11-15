import { spawnSync } from 'node:child_process';

// Por defecto usa las 3 réplicas de ../docker-compose.test.yml (puertos 55441-55443, base usuarios_test).
const replica = puerto => `postgres://usuarios:usuarios_desarrollo@127.0.0.1:${puerto}/usuarios_test`;
const resultado = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/integration/quorum.test.cjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_USUARIOS_DB_URLS: process.env.TEST_USUARIOS_DB_URLS ?? [55441, 55442, 55443].map(replica).join(','),
    TEST_RABBITMQ_URL: process.env.TEST_RABBITMQ_URL ?? 'amqp://acme:acme_desarrollo@127.0.0.1:55672',
  },
});
if (resultado.error) console.error(resultado.error);
process.exitCode = resultado.status ?? 1;
