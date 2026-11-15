/**
 * One command to see the app with invented data:
 *
 *   npm run demo
 *
 * Rebuilds the synthetic demo database, then starts the server against it.
 * Your real database is a different file and is not opened.
 */
const { DEMO_DATABASE } = await import('./seed-demo.ts');
process.env['DATABASE_PATH'] = DEMO_DATABASE;
await import('../src/index.ts');
