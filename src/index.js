const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
let ghToken = process.env.GITHUB_TOKEN;

async function run() {
  try {
    // Get inputs
    const token = core.getInput('github-token');
    const versioningBranch = core.getInput('versioning-branch') || 'versioning';
    const octokit = github.getOctokit(token);
    const { context } = github;
    ghToken = token;
    
    // 1. Versioner functionality
    await handleVersioner(octokit, context, versioningBranch);
    
    // 2. VersionBackup functionality
    await handleVersionBackup(octokit, context, versioningBranch);
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function handleVersioner(octokit, context, versioningBranch) {
  try {
    const fullVersioningBranch = `${versioningBranch}-${context.ref_name || 'main'}`;
    const repoUrl = `https://x-access-token:${ghToken}@github.com/${context.repo.owner}/${context.repo.repo}.git`;
    const cloneDir = `versioning-${Date.now()}`;
    
    // First, clone the repository (shallow clone)
    execSync(`git clone --depth 1 ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    process.chdir(cloneDir);
    
    // Check if the branch exists on remote and has commits
    const branchExists = await checkRemoteBranchExists(fullVersioningBranch);
    
    if (branchExists) {
      try {
        // Try to fetch and checkout the existing branch
        execSync(`git fetch origin ${fullVersioningBranch}`, { stdio: 'inherit' });
        // Create a local branch tracking the remote one
        execSync(`git checkout -b ${fullVersioningBranch} --track origin/${fullVersioningBranch}`, { 
          stdio: 'inherit',
          // This will make the command fail silently if the branch has no commits
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        // If we get here, the branch exists but has no commits
        core.info(`Branch ${fullVersioningBranch} exists but has no commits, creating a new one`);
        createNewVersioningBranch(fullVersioningBranch);
      }
    } else {
      createNewVersioningBranch(fullVersioningBranch);
    }
    
    // Set up git config
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync('git config user.name "GitHub Actions"');
    
    // Get or increment version
    let version = 1;
    if (fs.existsSync('version.v')) {
      version = parseInt(fs.readFileSync('version.v', 'utf8')) + 1;
    }
    fs.writeFileSync('version.v', version.toString());

    // Create version.json
    const commitDate = new Date().toISOString();
    const commitMessage = process.env.GITHUB_EVENT_NAME === 'push' 
      ? context.payload.head_commit.message 
      : 'Version update';
    
    const versionData = {
      commitHash: context.sha,
      commitDate,
      version: version.toString(),
      commitMessage
    };
    
    fs.writeFileSync('version.json', JSON.stringify(versionData, null, 2));
    
    // Create gsd_metadata.json if it doesn't exist
    if (!fs.existsSync('gsd_metadata.json')) {
      const metadata = {
        name: context.repo.repo,
        description: 'A GsD versioned project',
        readmeURL: `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/README.md`,
        author: context.actor,
        icon: '',
        license: 'MIT',
        versioningBranch: fullVersioningBranch,
        githubRepo: `${context.repo.owner}/${context.repo.repo}`,
        builtPackagePath: ''
      };
      
      fs.writeFileSync('gsd_metadata.json', JSON.stringify(metadata, null, 2));
    }

    // Commit and push changes
    execSync('git add version.v version.json gsd_metadata.json');
    execSync(`git commit -m "Update version to ${version} [skip ci]"`);
    
    // Push changes using the token for authentication
    const remoteUrl = `https://x-access-token:${ghToken}@github.com/${context.repo.owner}/${context.repo.repo}.git`;
    try {
      execSync(`git push ${remoteUrl} HEAD:${fullVersioningBranch}`, { stdio: 'pipe' });
    } catch (pushError) {
      core.info('Push rejected, attempting safe force push...');
      execSync(`git push --force ${remoteUrl} HEAD:${fullVersioningBranch}`, { stdio: 'inherit' });
    }

    core.setOutput('version', version.toString());
    core.setOutput('versioning-branch', fullVersioningBranch);

  } catch (error) {
    core.error('Error in versioner: ' + error.message);
    throw error;
  }
}

function createNewVersioningBranch(branchName) {
  core.info(`Creating new versioning branch: ${branchName}`);
  execSync(`git checkout --orphan ${branchName}`, { stdio: 'inherit' });
  // Remove all files from the index
  execSync('git rm -rf .', { stdio: 'inherit' });
  // Create initial commit
  execSync('git commit --allow-empty -m "Initial versioning branch"', { stdio: 'inherit' });
  
  // Try a regular push first, if it fails due to non-fast-forward, do a force push
  try {
    execSync(`git push -u origin ${branchName}`, { stdio: 'pipe' });
  } catch (pushError) {
    core.info('Push rejected, attempting safe force push...');
    execSync(`git push --force -u origin ${branchName}`, { stdio: 'inherit' });
  }
}

async function handleVersionBackup(octokit, context, versioningBranch) {
  try {
    const fullVersioningBranch = `${versioningBranch}-${context.ref_name || 'main'}`;
    
    // Ensure we're on the versioning branch
    execSync(`git checkout ${fullVersioningBranch}`);
    
    // Get current version
    const version = fs.readFileSync('version.v', 'utf8').trim();
    
    // Create versions directory if it doesn't exist
    const versionsDir = 'versions';
    const versionDir = path.join(versionsDir, version);
    const extDir = path.join(versionsDir, 'ext');
    
    [versionsDir, versionDir, extDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // Function to copy files recursively, excluding the versions directory and large files
    const copyRecursiveSync = (src, dest, baseDir = '') => {
      const exists = fs.existsSync(src);
      if (!exists) return;
      
      const stats = fs.statSync(src);
      const relativePath = path.relative(baseDir || process.cwd(), src);
      const fileName = path.basename(src);
      
      // Skip system and version control directories
      const EXCLUDE_DIRS = ['node_modules', 'venv', '__pycache__', '.git', "versions"];
      if (EXCLUDE_DIRS.includes(fileName) || 
          relativePath.split(path.sep).some(part => EXCLUDE_DIRS.includes(part))) {
        console.log(`Skipping excluded directory: ${relativePath}`);
        return;
      }
      
      // Skip the versions directory
      if (relativePath === 'versions' || relativePath.startsWith('versions/') || relativePath.startsWith('versions\\')) {
        return;
      }
      
      if (stats.isDirectory()) {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        
        if (fileName === 'versions') {
          return;
        }
        
        fs.readdirSync(src).forEach(childItem => {
          copyRecursiveSync(
            path.join(src, childItem),
            path.join(dest, childItem),
            baseDir || src
          );
        });
      } else {
        try {
          // Just copy the file - Git LFS will handle it if it's a tracked pattern
          fs.copyFileSync(src, dest);
        } catch (error) {
          console.error(`Error copying ${src} to ${dest}:`, error.message);
        }
      }
    };

    // Get list of files to copy (excluding versions and git directory)
    const files = fs.readdirSync('.').filter(file => 
      !['versions', '.git', `${versionDir}.zip`].includes(file)
    );
    
    // Create version directory if it doesn't exist
    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
    }
    
    // Copy each file/directory
    files.forEach(file => {
      const source = path.resolve(file);
      const dest = path.join(versionDir, file);
      copyRecursiveSync(source, dest, process.cwd());
    });
    
    // Create zip archives, excluding the versions directory and large files
    const createZip = (sourceDir, zipFile) => {
      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max file size
      const files = [];
      
      // Get all files with size check
      fs.readdirSync(sourceDir).forEach(file => {
        if (file === 'versions' || file.endsWith('.zip')) return;
        
        const filePath = path.join(sourceDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.size > MAX_FILE_SIZE) {
          console.warn(`Skipping large file: ${file} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
          return;
        }
        
        files.push(file);
      });
      
      if (files.length === 0) return;
      
      const filesList = files
        .map(f => `"${f.replace(/"/g, '\\"')}"`)
        .join(' ');
      
      try {
        execSync(`cd "${sourceDir}" && zip -r "${zipFile}" ${filesList} -x "*/\.*" -x "*.git*" -x "*node_modules*" -x "*venv*" -x "*__pycache__*"`, { 
          stdio: 'inherit',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024 // 50MB buffer for zip command
        });
      } catch (error) {
        console.warn(`Warning: Failed to create zip ${zipFile}:`, error.message);
        // If zip fails, try with a smaller file list
        if (files.length > 1) {
          console.log('Trying with fewer files...');
          const half = Math.ceil(files.length / 2);
          createZip(sourceDir, zipFile, files.slice(0, half));
          createZip(sourceDir, zipFile, files.slice(half));
        }
      }
    };
    
    // Create version zip
    createZip('.', path.resolve(versionDir + '.zip'));
    
    // Create latest zip in ext directory
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }
    
    // Make sure we're not trying to zip the versions directory
    if (fs.existsSync(versionDir)) {
      createZip(versionDir, path.resolve(path.join(extDir, 'latest.zip')));
    }

    // Update versionlist.json
    let versionList = { versions: [] };
    if (fs.existsSync('versionlist.json')) {
      versionList = JSON.parse(fs.readFileSync('versionlist.json', 'utf8'));
    }
    
    versionList.versions.push({
      version,
      commitHash: context.sha,
      commitDate: new Date().toISOString(),
      commitMessage: process.env.GITHUB_EVENT_NAME === 'push' 
        ? context.payload.head_commit.message 
        : 'Version update'
    });
    
    fs.writeFileSync('versionlist.json', JSON.stringify(versionList, null, 2));
    
    // Copy version files to ext directory
    ['version.v', 'version.json', 'versionlist.json'].forEach(file => {
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(versionDir, file));
        fs.copyFileSync(file, path.join(extDir, file));
      }
    });

    // Create change logs
    const changeLog = `Commit Hash: ${context.sha}
Commit Date: ${new Date().toISOString()}
Commit Message: ${process.env.GITHUB_EVENT_NAME === 'push' ? context.payload.head_commit.message : 'Version update'}
Version: ${version}`;

    fs.writeFileSync(path.join(versionDir, 'change_log.txt'), changeLog);
    fs.writeFileSync(path.join(extDir, 'change_log.txt'), changeLog);

    // Set Git user info (in case this is a new repository)
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync('git config user.name "GitHub Actions"');
    
    // Commit and push changes with token authentication
    execSync('git add .');
    execSync(`git commit -m "Backup version ${version} [skip ci]"`);
    
    // Push changes using the token for authentication
    const remoteUrl = `https://x-access-token:${ghToken}@github.com/${context.repo.owner}/${context.repo.repo}.git`;
    try {
      execSync(`git push ${remoteUrl} HEAD:${fullVersioningBranch}`, { stdio: 'pipe' });
    } catch (pushError) {
      core.info('Push rejected, attempting safe force push...');
      execSync(`git push --force ${remoteUrl} HEAD:${fullVersioningBranch}`, { stdio: 'inherit' });
    }

  } catch (error) {
    core.error('Error in version backup: ' + error.message);
    throw error;
  }
}

// Helper function to check if a branch exists on remote
async function checkRemoteBranchExists(branchName) {
  try {
    const result = execSync(`git ls-remote --heads origin ${branchName}`, { stdio: 'pipe' }).toString();
    return result.trim() !== '';
  } catch (error) {
    return false;
  }
}

// Run the action
run();