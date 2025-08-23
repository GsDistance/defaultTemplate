const core = require('@actions/core');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const execP = util.promisify(exec);

async function run() {
  try {
    console.log('Setting up Git LFS...');
    
    // Get the workspace directory from environment
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    console.log(`Workspace: ${workspace}`);
    
    // Change to workspace directory
    process.chdir(workspace);
    
    // Check if we're in a git repository
    try {
      await execP('git rev-parse --is-inside-work-tree');
    } catch (error) {
      core.warning('Not in a Git repository. Initializing new repository...');
      await execP('git init');
    }
    
    // Set git config
    await execP('git config --global --add safe.directory /github/workspace');
    
    // Check Git LFS
    try {
      await execP('git lfs version');
    } catch (error) {
      core.warning('Git LFS is not available. Make sure actions/checkout@v3 has lfs:true');
      return;
    }
    
    // Configure Git LFS
    try {
      await execP('git lfs install --local');
    } catch (error) {
      console.warn('Failed to install Git LFS locally, trying global install...');
      await execP('git lfs install');
    }
    
    // Set Git LFS config
    const repoUrl = process.env.GITHUB_REPOSITORY || 'unknown/unknown';
    await execP('git config lfs.basictransfersonly true');
    await execP(`git config lfs.https://github.com/${repoUrl}.git/info/lfs.locksverify false`);
    
    // Create .gitattributes if it doesn't exist
    const gitAttributesPath = '.gitattributes';
    let gitAttributes = '';
    
    if (fs.existsSync(gitAttributesPath)) {
      gitAttributes = fs.readFileSync(gitAttributesPath, 'utf8');
    }
    
    // Add common binary file patterns
    const commonPatterns = [
      '*.zip', '*.gz', '*.7z', '*.rar', '*.tar', '*.tgz', '*.bz2', '*.xz',
      '*.iso', '*.dmg', '*.pkg', '*.exe', '*.dll', '*.so', '*.dylib',
      '*.class', '*.jar', '*.war', '*.ear', '*.bin', '*.dat', '*.dump', '*.img'
    ];

    commonPatterns.forEach(pattern => {
      if (!gitAttributes.includes(pattern)) {
        gitAttributes += `\n${pattern} filter=lfs diff=lfs merge=lfs -text`;
      }
    });

    fs.writeFileSync(gitAttributesPath, gitAttributes.trim());
    
    // Track any existing large files
    const lfsThreshold = core.getInput('lfs-threshold-mb') || '90';
    try {
      const { stdout } = await execP(`find . -type f -size +${lfsThreshold}M -not -path "*/\.git/*" -not -path "*/node_modules/*"`);
      const largeFiles = stdout.trim().split('\n').filter(Boolean);
      
      if (largeFiles.length > 0) {
        console.log(`Found ${largeFiles.length} large file(s) to track with Git LFS`);
        for (const file of largeFiles) {
          try {
            await execP(`git lfs track "${file}"`);
            console.log(`Tracking ${file} with Git LFS`);
          } catch (trackError) {
            console.warn(`Could not track ${file} with Git LFS:`, trackError.message);
          }
        }
      }
    } catch (error) {
      console.warn('Error finding large files:', error.message);
    }
    
    // Add and commit .gitattributes if changed
    await execP('git add .gitattributes');
    await execP('git config --global user.name "github-actions[bot]"');
    await execP('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    try {
      await execP('git commit -m "Update Git LFS configuration"');
    } catch (error) {
      // No changes to commit is fine
      if (!error.message.includes('nothing to commit')) {
        throw error;
      }
    }
    
  } catch (error) {
    core.warning(`Git LFS setup failed: ${error.message}`);
    // Continue execution even if LFS setup fails
  }
}

run();
