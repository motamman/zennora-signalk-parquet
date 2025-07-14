# Publishing to NPM and Organizing Git Repositories

This document explains how to publish Zennora packages to NPM and organize the Git repositories.

## NPM Publishing Options

### Prerequisites
1. Create an NPM account at [npmjs.com](https://npmjs.com)
2. Login locally: `npm login`
3. Each package needs a `package.json` file

### Option A: Individual NPM Packages (Recommended for beginners)

Each folder becomes a separate NPM package:

```bash
cd zennora-signalk-parquet
npm init -y
```

Edit the generated `package.json`:
```json
{
  "name": "zennora-signalk-parquet",
  "version": "1.0.0",
  "description": "SignalK to Parquet data storage plugin",
  "main": "index.js",
  "keywords": ["signalk", "parquet", "marine", "data"],
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/yourusername/repo-name.git"
  },
  "bugs": {
    "url": "https://github.com/yourusername/repo-name/issues"
  },
  "homepage": "https://github.com/yourusername/repo-name#readme"
}
```

Publish:
```bash
npm publish
```

Users install with:
```bash
npm install zennora-signalk-parquet
```

### Option B: Scoped Packages

Use organization naming for related packages:

```json
{
  "name": "@zennora/signalk-parquet",
  "name": "@zennora/signalk-other"
}
```

Publish:
```bash
npm publish --access public
```

Users install with:
```bash
npm install @zennora/signalk-parquet
```

### Option C: Monorepo with Workspaces

Keep all packages in one repo, publish separately. Add to root `package.json`:

```json
{
  "workspaces": [
    "zennora-signalk-parquet",
    "other-package"
  ]
}
```

## Git Repository Organization

### Option 1: Separate Repositories (Simplest)

Create individual repositories for each package.

**Pros:**
- Simple to understand and manage
- Each package has its own issues, releases, and README
- Users only clone what they need
- Independent versioning
- Familiar to most developers

**Cons:**
- Have to manage multiple repositories
- Code sharing between packages requires separate dependency management

**Setup:**

1. **Create new repositories on GitHub:**
   - Go to GitHub → New Repository
   - Name: `zennora-signalk-parquet`
   - Description: "SignalK to Parquet data storage plugin"
   - Keep it public
   - Don't add README/gitignore (we'll move existing files)

2. **Move each folder to its own repository:**
   ```bash
   # For the parquet package
   cd /path/to/your/current/repo
   cp -r zennora-signalk-parquet /tmp/zennora-signalk-parquet
   cd /tmp/zennora-signalk-parquet

   # Initialize git and push
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/yourusername/zennora-signalk-parquet.git
   git push -u origin main
   ```

3. **Repeat for each package:**
   ```bash
   cp -r zennora-other-package /tmp/zennora-other-package
   cd /tmp/zennora-other-package
   # ... same git commands with different repo URL
   ```

4. **Update package.json in each repository:**
   ```json
   {
     "repository": {
       "type": "git",
       "url": "git+https://github.com/yourusername/zennora-signalk-parquet.git"
     }
   }
   ```

5. **Clean up main repository (optional):**
   Remove the folders from your main repo since they now live separately.

### Option 2: Git Subtrees (Advanced)

Keep everything in one main repository while creating separate sub-repositories that stay in sync.

**Pros:**
- Work in one repository day-to-day
- Automatically sync changes to separate repositories
- Maintain history and relationships between packages
- Can still publish packages independently

**Cons:**
- More complex to set up and understand
- Requires understanding of git subtrees
- Can be confusing for contributors

**Setup:**

1. **Create separate repositories on GitHub:**
   - Create `zennora-signalk-parquet` repo (empty, no README)
   - Create other repos for each package you want to split

2. **Add them as remotes to your main repository:**
   ```bash
   git remote add parquet-repo https://github.com/yourusername/zennora-signalk-parquet.git
   git remote add other-repo https://github.com/yourusername/zennora-other-package.git
   ```

3. **Push subdirectories to separate repositories:**
   ```bash
   # Push the parquet folder to its own repo
   git subtree push --prefix=zennora-signalk-parquet parquet-repo main

   # Push other folders
   git subtree push --prefix=zennora-other-package other-repo main
   ```

4. **Daily workflow - when you make changes:**
   ```bash
   # Work in your main repo as normal
   git add .
   git commit -m "Update parquet plugin"
   git push origin main
   
   # Then sync to sub-repositories
   git subtree push --prefix=zennora-signalk-parquet parquet-repo main
   git subtree push --prefix=zennora-other-package other-repo main
   ```

5. **Each sub-repository gets its own package.json:**
   ```json
   {
     "name": "zennora-signalk-parquet",
     "repository": {
       "type": "git",
       "url": "git+https://github.com/yourusername/zennora-signalk-parquet.git"
     }
   }
   ```

## Recommended Approach

For beginners: **Option 1 (Separate Repositories) + Option A (Individual NPM Packages)**

This combination is:
- Easiest to understand
- Most familiar to other developers
- Simplest to maintain
- Standard practice in the JavaScript ecosystem

## Testing Before Publishing

Always test your packages locally before publishing:

```bash
# Create a test package
npm pack

# Test installing in another project
cd /path/to/test/project
npm install /path/to/your/package/zennora-signalk-parquet-1.0.0.tgz
```

## Publishing Checklist

- [ ] Package.json has correct name, version, description
- [ ] Repository links are correct
- [ ] README.md exists and explains usage
- [ ] Code is tested and working
- [ ] Version number follows [semantic versioning](https://semver.org/)
- [ ] You're logged into NPM: `npm whoami`
- [ ] Run `npm publish --dry-run` first to check