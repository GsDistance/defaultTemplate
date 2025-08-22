const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    // Get inputs
    const token = core.getInput('github-token');
    const versioningBranch = core.getInput('versioning-branch') || 'versioning';
    const octokit = github.getOctokit(token);
    const { context } = github;
    
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
    
    // Clone the repository
    execSync('git config --global user.name "github-actions[bot]"');
    execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    
    // Check if versioning branch exists
    const branchExists = await octokit.rest.repos.getBranch({
      owner: context.repo.owner,
      repo: context.repo.repo,
      branch: fullVersioningBranch
    }).then(() => true).catch(() => false);

    if (!branchExists) {
      // Create new branch
      execSync(`git checkout --orphan ${fullVersioningBranch}`);
      execSync('git rm -rf .');
      execSync('git commit --allow-empty -m "Initial commit for versioning branch"');
      execSync(`git push -u origin ${fullVersioningBranch}`);
    } else {
      // Checkout existing branch
      execSync(`git fetch origin ${fullVersioningBranch}`);
      execSync(`git checkout ${fullVersioningBranch}`);
    }

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

    // Commit and push changes
    execSync('git add version.v version.json');
    execSync(`git commit -m "Update version to ${version}"`);
    execSync(`git push origin ${fullVersioningBranch}`);

    core.setOutput('version', version.toString());
    core.setOutput('versioning-branch', fullVersioningBranch);

  } catch (error) {
    core.error('Error in versioner: ' + error.message);
    throw error;
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

    // Function to copy files recursively
    const copyRecursiveSync = (src, dest) => {
      const exists = fs.existsSync(src);
      const stats = exists && fs.statSync(src);
      const isDirectory = exists && stats.isDirectory();
      
      if (isDirectory) {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(childItem => {
          copyRecursiveSync(path.join(src, childItem), path.join(dest, childItem));
        });
      } else {
        fs.copyFileSync(src, dest);
      }
    };

    // Copy files to version directory, excluding the versions directory and any existing zip files
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
      copyRecursiveSync(source, dest);
    });
    
    // Create zip archives
    const createZip = (sourceDir, zipFile) => {
      const files = fs.readdirSync(sourceDir).filter(file => file !== 'versions');
      const filesList = files.map(f => `"${f}"`).join(' ');
      execSync(`cd "${sourceDir}" && zip -r "${zipFile}" ${filesList}`, { stdio: 'inherit' });
    };
    
    // Create version zip
    createZip('.', versionDir + '.zip');
    
    // Create latest zip in ext directory
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }
    createZip(versionDir, path.join(extDir, 'latest.zip'));

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

    // Commit and push changes
    execSync('git add .');
    execSync(`git commit -m "Backup version ${version}"`);
    execSync(`git push origin ${fullVersioningBranch}`);

  } catch (error) {
    core.error('Error in version backup: ' + error.message);
    throw error;
  }
}

// Run the action
run();