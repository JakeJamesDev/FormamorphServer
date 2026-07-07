const { listSnapshots } = require('./worldSnapshot');

async function main() {
  console.log('=== Available World Snapshots ===\n');
  
  const snapshots = await listSnapshots();
  
  if (snapshots.length === 0) {
    console.log('No snapshots found.');
    console.log('Create a snapshot with: npm run snapshot');
    process.exit(0);
  }
  
  console.log(`Found ${snapshots.length} snapshot(s):\n`);
  
  snapshots.forEach((snapshot, index) => {
    console.log(`${index + 1}. ${snapshot.name}`);
    console.log(`   Size: ${snapshot.sizeInMB} MB`);
    console.log(`   Created: ${new Date(snapshot.created).toLocaleString()}`);
    console.log(`   Path: ${snapshot.path}`);
    console.log('');
  });
  
  process.exit(0);
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
