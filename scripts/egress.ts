// Run: npm run egress          — what this database has sent since the last reset
//      npm run egress -- --reset — zero the counters, to measure one task in isolation
//
// Neon meters *network transfer out of the compute*, and that is the limit this project actually
// runs into: a 5 GB monthly allowance went to 8.44 GB during one epic and the project was
// suspended mid-work. Compute and storage were nowhere near their limits. Nothing warned us,
// because pg_stat_statements was not installed and nobody was looking.
//
// Postgres does not count bytes sent, so this counts rows and prices them. The calibration comes
// from a measured request: one /api/world pulled 28,583 rows (16,384 from the tile scan plus
// 12,199 from the tile-to-resource join) for about 1.3 MB on the wire, which is ~46 bytes a row
// once DataRow framing is included. That is an estimate and it says so — the authoritative figure
// is the Network transfer tile on Neon's project dashboard. This exists to catch a problem the
// same day rather than in a 100%-of-allowance email.
import postgres from 'postgres';

/** Measured against this app's own query mix — see the header. */
const BYTES_PER_ROW = 46;
/** Free tier. Neon's Launch plan includes 500 GB per project. */
const ALLOWANCE_GB = 5;

const sql = postgres(process.env.DATABASE_URL!, { max: 1, idle_timeout: 5 });

try {
	const [available] = await sql`
		select installed_version from pg_available_extensions where name = 'pg_stat_statements'`;
	if (!available?.installed_version) {
		// Worth saying out loud rather than reporting a confident zero: without the extension there
		// is no per-query history at all, which is exactly the blind spot that let this creep up.
		console.log('pg_stat_statements is not installed — no per-query history to report.');
		console.log('Enable it with: create extension pg_stat_statements;');
		process.exit(1);
	}

	if (process.argv.includes('--reset')) {
		await sql`select pg_stat_statements_reset()`;
		console.log('counters reset — run this again after the work to see what it cost');
	} else {
		// Neon runs its own monitoring queries against every database; they are noise here, and
		// they are not what anybody is trying to find out about.
		const rows = await sql<{ calls: number; rows: number; q: string }[]>`
			select
				calls::int,
				rows::int,
				left(regexp_replace(query, '\s+', ' ', 'g'), 90) as q
			from pg_stat_statements
			where query not ilike '%pg_stat%'
				and query not ilike '%pg_catalog%'
				and query not ilike '%pg_settings%'
				and query not ilike '%pg_database%'
				and query not ilike '%neon.%'
				and query not ilike '%neon_%'
			order by rows desc`;

		const totalRows = rows.reduce((sum, r) => sum + r.rows, 0);
		const mb = (totalRows * BYTES_PER_ROW) / 1e6;
		const pct = (mb / 1000 / ALLOWANCE_GB) * 100;

		console.log(`\nrows sent: ${totalRows.toLocaleString()}`);
		console.log(
			`estimated egress: ${mb.toFixed(1)} MB  (~${pct.toFixed(1)}% of a ${ALLOWANCE_GB} GB allowance)`
		);
		console.log('\nheaviest statements:');
		for (const r of rows.slice(0, 8)) {
			const share = totalRows ? ((r.rows / totalRows) * 100).toFixed(0) : '0';
			console.log(
				`  ${String(r.rows).padStart(9)} rows  ${String(r.calls).padStart(5)} calls  ${share.padStart(3)}%  ${r.q}`
			);
		}
		console.log('\nAuthoritative figure: the Network transfer tile on Neon’s project dashboard.');
	}
} finally {
	await sql.end();
}
