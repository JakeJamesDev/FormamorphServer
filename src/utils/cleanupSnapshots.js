const { cleanupOldSnapshots } = require('./worldSnapshot');

async function main() {
  console.log('=== World Snapshot Cleanup ===\n');
  
  // Get keep count from command line args (default to 3)
  const keepCount = parseInt(process.argv[2]) || 3;
  
  console.log(`Keeping the ${keepCount} most recent snapshots...\n`);
  
  const result = await cleanupOldSnapshots(keepCount);
  
  if (result.error) {
    console.error('Cleanup failed:', result.error);
    process.exit(1);
  }
  
  console.log('\n=== Cleanup Complete ===');
  process.exit(0);
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
