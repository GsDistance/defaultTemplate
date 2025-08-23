const { exec } = require('child_process');
const util = require('util');
const execP = util.promisify(exec);

async function run() {
  try {
    // Ensure all LFS files are properly tracked and committed
    console.log('Finalizing Git LFS operations...');
    
    // Add any remaining LFS files
    await execP('git add .gitattributes');
    await execP('git add .');
    
    // Try to commit any remaining changes
    try {
      await execP('git commit -m "Update Git LFS tracked files"');
    } catch (error) {
      // No changes to commit is fine
      if (!error.message.includes('nothing to commit')) {
        console.warn('Error during cleanup:', error.message);
      }
    }
    
    console.log('Git LFS cleanup completed');
  } catch (error) {
    console.warn('Error during Git LFS cleanup:', error.message);
    // Don't fail the action if cleanup fails
  }
}

run();
