import sql from 'mssql';
import { z } from 'zod';

export type ProcedureParameterType = 'nvarchar' | 'uniqueidentifier' | 'bit' | 'int' | 'datetime2';
export interface ProcedureDefinition {
  name: string;
  parameters: Readonly<Record<string, ProcedureParameterType>>;
}

export interface SqlConnectionConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  options: { encrypt: true; trustServerCertificate: false };
  pool: { max: 5; min: 0; idleTimeoutMillis: 30_000 };
  connectionTimeout: 60_000;
  requestTimeout: 30_000;
}

export interface SqlRuntimeConnection {
  execute(
    ownerId: string,
    procedure: string,
    values: Readonly<Record<string, string | boolean | number | null>>,
    definition: ProcedureDefinition,
  ): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface SqlRuntimeDriver {
  connect(config: SqlConnectionConfig): Promise<SqlRuntimeConnection>;
}

interface RuntimeDependencies {
  driver?: SqlRuntimeDriver;
  sleep?: (milliseconds: number) => Promise<void>;
}

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
const ownerId = z.string().uuid();
const transientErrors = new Set([
  20, 64, 233, 4060, 40143, 40197, 40501, 40540, 40613,
  10053, 10054, 10060, 10928, 10929, 49918, 49919, 49920,
]);
const delays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

function errorNumber(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('number' in error)) return undefined;
  return typeof error.number === 'number' ? error.number : undefined;
}

function inputType(type: ProcedureParameterType):
  ReturnType<typeof sql.NVarChar> | typeof sql.UniqueIdentifier | typeof sql.Bit | typeof sql.Int | typeof sql.DateTime2 {
  if (type === 'nvarchar') return sql.NVarChar(sql.MAX);
  if (type === 'uniqueidentifier') return sql.UniqueIdentifier;
  if (type === 'bit') return sql.Bit;
  if (type === 'int') return sql.Int;
  return sql.DateTime2;
}

const mssqlDriver: SqlRuntimeDriver = {
  async connect(config) {
    const pool = await new sql.ConnectionPool(config).connect();
    return {
      async execute(subject, procedure, values, definition) {
        const transaction = new sql.Transaction(pool);
        let contextSet = false;
        let cleanupError: unknown;
        await transaction.begin();
        try {
          contextSet = true;
          await new sql.Request(transaction)
            .input('owner_oid', sql.NVarChar(36), subject)
            .query("EXEC sys.sp_set_session_context @key=N'oid', @value=@owner_oid, @read_only=0;\n" +
              "EXEC sys.sp_set_session_context @key=N'scp', @value=N'access_as_user', @read_only=0;");
          const request = new sql.Request(transaction);
          for (const [name, type] of Object.entries(definition.parameters)) {
            request.input(name, inputType(type), values[name]);
          }
          const result = await request.execute(procedure);
          await new sql.Request(transaction)
            .query("EXEC sys.sp_set_session_context @key=N'scp', @value=NULL, @read_only=0;\n" +
              "EXEC sys.sp_set_session_context @key=N'oid', @value=NULL, @read_only=0;");
          contextSet = false;
          await transaction.commit();
          return result.recordset ?? [];
        } catch (error) {
          if (contextSet) {
            try {
              await new sql.Request(transaction)
                .query("EXEC sys.sp_set_session_context @key=N'scp', @value=NULL, @read_only=0;\n" +
                  "EXEC sys.sp_set_session_context @key=N'oid', @value=NULL, @read_only=0;");
            } catch (cleanup) {
              cleanupError = cleanup;
            }
          }
          await transaction.rollback().catch(() => {});
          if (cleanupError) {
            await pool.close();
            throw new Error('SQL owner context cleanup failed; the connection pool was discarded', { cause: cleanupError });
          }
          throw error;
        }
      },
      async close() { await pool.close(); },
    };
  },
};

export function createProcedureRuntime(
  env: NodeJS.ProcessEnv,
  procedures: readonly ProcedureDefinition[],
  dependencies: RuntimeDependencies = {},
) {
  const settings = z.strictObject({
    server: z.string().regex(/^[a-z0-9-]+\.database\.windows\.net$/),
    database: z.literal('app'),
    user: z.literal('sql_apps_runtime'),
    password: z.string().min(32),
  }).parse({
    server: env.AZURE_SQL_SERVER,
    database: env.AZURE_SQL_DATABASE,
    user: env.AZURE_SQL_USER,
    password: env.AZURE_SQL_PASSWORD,
  });
  const definitions = new Map<string, ProcedureDefinition>();
  for (const definition of procedures) {
    identifier.parse(definition.name);
    if (definitions.has(definition.name)) throw new Error(`Duplicate declared SQL procedure: ${definition.name}`);
    for (const name of Object.keys(definition.parameters)) identifier.parse(name);
    definitions.set(definition.name, Object.freeze({
      name: definition.name,
      parameters: Object.freeze({ ...definition.parameters }),
    }));
  }
  const driver = dependencies.driver ?? mssqlDriver;
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const config: SqlConnectionConfig = {
    ...settings,
    port: 1433,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 60_000,
    requestTimeout: 30_000,
  };
  let connection: Promise<SqlRuntimeConnection> | undefined;
  const connect = async (): Promise<SqlRuntimeConnection> => {
    for (let attempt = 0; ; attempt++) {
      try {
        connection ??= driver.connect(config);
        return await connection;
      } catch (error) {
        connection = undefined;
        if (!transientErrors.has(errorNumber(error) ?? -1) || attempt >= delays.length) throw error;
        await sleep(delays[attempt]!);
      }
    }
  };
  return {
    async execute(subject: string, procedure: string, values: Record<string, string | boolean | number | null>) {
      ownerId.parse(subject);
      const definition = definitions.get(procedure);
      if (!definition) throw new Error('SQL procedure is not declared for this application');
      const expected = Object.keys(definition.parameters).sort();
      const actual = Object.keys(values).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('SQL procedure parameters do not match the declaration');
      return (await connect()).execute(subject, procedure, values, definition);
    },
    async ready() { await connect(); },
    async close() {
      if (connection) await (await connection).close();
      connection = undefined;
    },
  };
}
