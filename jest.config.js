module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'], // Ensure Jest finds the test file
  // Live SAP calls (lock → PUT → unlock → activate) routinely exceed Jest's 5 s default. A test that
  // times out is marked failed while its SAP calls keep running, and a forced exit then kills them
  // between LOCK and UNLOCK — leaving the object enqueued by an orphaned session until SAP times it out.
  testTimeout: 120000,
  // All suites hit the same live SAP system, and the stateful-operation gate (src/lib/writeLock.ts)
  // allows one LOCK flow at a time per system — it refuses ("Blocked: …") rather than queues. Parallel
  // workers made suites refuse each other's writes at random; run the files one after another.
  maxWorkers: 1,
};
