/**
 * The PgBouncer settings of the harness, as data. `devenv.nix` does not repeat them: `devenv up` runs `bun run stack`,
 * which renders this profile.
 *
 * `neonProfile` is Neon's published PgBouncer configuration, quoted from
 * https://neon.com/docs/connect/connection-pooling (read 2026-10-29): `pool_mode=transaction`, `max_client_conn=10000`,
 * `default_pool_size=0.9 x max_connections`, `max_prepared_statements=1000`, `query_wait_timeout=120`.
 */
export interface PgBouncerSettings {
  readonly poolMode: "transaction" | "session" | "statement";
  readonly maxClientConn: number;
  readonly defaultPoolSize: number;
  readonly maxPreparedStatements: number;
  readonly queryWaitTimeout: number;
}

export const neonProfile = (
  postgresMaxConnections: number
): PgBouncerSettings => ({
  defaultPoolSize: Math.floor(postgresMaxConnections * 0.9),
  maxClientConn: 10_000,
  maxPreparedStatements: 1000,
  poolMode: "transaction",
  queryWaitTimeout: 120,
});

/** The matrix of the harness varies exactly the settings that decide a client's behaviour. */
export interface MatrixCell {
  readonly label: string;
  readonly settings: Pick<
    PgBouncerSettings,
    "defaultPoolSize" | "maxPreparedStatements"
  >;
}

const maxPreparedStatementsValues = [0, 1000] as const;

const poolSizes = [1, 5] as const;

export const matrix: readonly MatrixCell[] =
  maxPreparedStatementsValues.flatMap((maxPreparedStatements) =>
    poolSizes.map((defaultPoolSize): MatrixCell => ({
      label: `max_prepared_statements=${maxPreparedStatements} default_pool_size=${defaultPoolSize}`,
      settings: { defaultPoolSize, maxPreparedStatements },
    }))
  );

export interface IniInput {
  readonly settings: PgBouncerSettings;
  readonly listenPort: number;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
  };
  /** Directory for the log, pid and user list files. */
  readonly dir: string;
  /** Whether to keep `max_client_conn` within the open-file limit of this process. */
  readonly fileLimit: number;
}

/**
 * The configuration file. `max_client_conn` is the profile's value, lowered to fit the open-file limit when that limit
 * is lower, because PgBouncer refuses to start otherwise; the lowered value is the only deviation from the profile.
 */
export const renderPgBouncerIni = (input: IniInput): string => {
  const { settings, database, dir } = input;

  const maxClientConn = Math.min(
    settings.maxClientConn,
    Math.max(10, input.fileLimit - 64)
  );

  return [
    "[databases]",
    `${database.name} = host=${database.host} port=${database.port} dbname=${database.name} user=${database.user}`,
    "",
    "[pgbouncer]",
    "listen_addr = 127.0.0.1",
    `listen_port = ${input.listenPort}`,
    "auth_type = trust",
    `auth_file = ${dir}/userlist.txt`,
    "unix_socket_dir =",
    `logfile = ${dir}/pgbouncer.log`,
    `pidfile = ${dir}/pgbouncer.pid`,
    `pool_mode = ${settings.poolMode}`,
    `max_client_conn = ${maxClientConn}`,
    `default_pool_size = ${settings.defaultPoolSize}`,
    `max_prepared_statements = ${settings.maxPreparedStatements}`,
    `query_wait_timeout = ${settings.queryWaitTimeout}`,
    "",
  ].join("\n");
};
