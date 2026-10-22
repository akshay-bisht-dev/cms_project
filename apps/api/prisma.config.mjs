// Prisma CLI configuration (replaces the deprecated package.json#prisma block).
// With a config file Prisma no longer auto-loads .env; scripts load the root .env via dotenv-cli.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
});
