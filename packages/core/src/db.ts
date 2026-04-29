/**
 * Database connection and query utilities.
 * Uses postgres.js for type-safe, fast Postgres access.
 */

import postgres from 'postgres';
import type { BrainConfig, DatabaseConfig } from './types.js';

let sql: postgres.Sql | null = null;

export function getConnectionString(config: BrainConfig): string {
  if (typeof config.database === 'string') {
    return config.database;
  }
  const db = config.database as DatabaseConfig;
  const ssl = db.ssl ? '?sslmode=require' : '';
  return `postgresql://${db.user}:${db.password}@${db.host}:${db.port}/${db.database}${ssl}`;
}

export function connect(config: BrainConfig): postgres.Sql {
  if (sql) return sql;

  const connectionString = getConnectionString(config);
  sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return sql;
}

export function getDb(): postgres.Sql {
  if (!sql) throw new Error('Database not connected. Call connect() first.');
  return sql;
}

export async function disconnect(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

export async function initSchema(db: postgres.Sql): Promise<void> {
  const { readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(__dirname, 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');

  await db.unsafe(schemaSql);
}
