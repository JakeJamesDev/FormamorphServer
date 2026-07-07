const { createWorldSnapshot } = require('./worldSnapshot');

async function main() {
  console.log('=== Exotic Dangerous World Snapshot Creator ===\n');
  
  // Get custom name from command line args if provided
  const customName = process.argv[2];
  
  if (customName) {
    console.log(`Creating snapshot with custom name: ${customName}\n`);
  }
  
  const result = await createWorldSnapshot(customName);
  
  if (result.success) {
    console.log('\n=== Snapshot Complete ===');
    process.exit(0);
  } else {
    console.error('\n=== Snapshot Failed ===');
    console.error('Error:', result.error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
