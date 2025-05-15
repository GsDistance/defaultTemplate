# defaultTemplate

Template repository for quick setup.

## Usage

### versioner.yml

The versioner workflow will update the version.json and version.v files in the versioning branch which it creates every push.
It is simply to keep a version history of the application, for whatever use you want.

### versionBackup.yml

The versionBackup workflow will create a backup of the files in the versioning branch.
This is mostly if you want people to be able to access multiple versions of the program.
As it puts the versionBrowser.html file in the root of the repository, you set the github pages to the versioning branch to use it.

## License: [MIT](LICENSE)
