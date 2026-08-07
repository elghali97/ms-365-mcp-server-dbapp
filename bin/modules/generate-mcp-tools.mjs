import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);

// Resolve the openapi-zod-client CLI entrypoint from the installed dependency instead
// of shelling out to `npx`. The Databricks Apps build shell does not have `npx` on its
// PATH, so `npx -y openapi-zod-client` fails there with "npx: not found". Running the
// package's own bin script through the current Node binary is PATH-independent and
// avoids an on-the-fly npm fetch. openapi-zod-client is a direct dependency for this.
function resolveOpenapiZodClientBin() {
  const pkgJsonPath = require.resolve('openapi-zod-client/package.json');
  const pkgDir = path.dirname(pkgJsonPath);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['openapi-zod-client'];
  if (!binRel) {
    throw new Error('Could not locate the openapi-zod-client bin entry in its package.json');
  }
  return path.join(pkgDir, binRel);
}

// Resolve the prettier CLI from the installed devDependency, or return null when it is
// not installed (production install). PATH-independent, like the client bin resolver.
function tryResolvePrettierBin() {
  try {
    const pkgJsonPath = require.resolve('prettier/package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prettier;
    return binRel ? path.join(pkgDir, binRel) : null;
  } catch {
    return null;
  }
}

export function generateMcpTools(openapiTrimmedFile, clientFilePath) {
  try {
    console.log(
      `Generating ${path.basename(clientFilePath)} from ${path.basename(openapiTrimmedFile)} using openapi-zod-client...`
    );

    const outputDir = path.dirname(clientFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`Created directory: ${outputDir}`);
    }

    execFileSync(
      process.execPath,
      [
        resolveOpenapiZodClientBin(),
        openapiTrimmedFile,
        '-o',
        clientFilePath,
        '--with-description',
        '--strict-objects',
        '--additional-props-default-value=false',
      ],
      {
        stdio: 'inherit',
      }
    );

    console.log(`Generated client code at: ${clientFilePath}`);

    let clientCode = fs.readFileSync(clientFilePath, 'utf-8');
    clientCode = clientCode.replace(/'@zodios\/core';/, "'./hack.js';");

    clientCode = clientCode.replace(/\.strict\(\)/g, '.passthrough()');

    console.log('Stripping unused errors arrays from endpoint definitions...');
    // I didn't make up this crazy regex myself; you know who did. It seems works though.
    clientCode = clientCode.replace(/,?\s*errors:\s*\[[\s\S]*?],?(?=\s*})/g, '');

    console.log('Decoding HTML entities in path patterns...');
    // openapi-zod-client HTML-encodes special characters in path patterns
    // This breaks Microsoft Graph function-style APIs like range(address='A1:G10')
    clientCode = clientCode.replace(/&#x3D;/g, '='); // Decode = sign
    clientCode = clientCode.replace(/&#x27;/g, "'"); // Decode single quote
    clientCode = clientCode.replace(/&#x28;/g, '('); // Decode left paren
    clientCode = clientCode.replace(/&#x29;/g, ')'); // Decode right paren
    clientCode = clientCode.replace(/&#x3A;/g, ':'); // Decode colon

    console.log('Fixing function-style API paths with template literals...');
    // After HTML decoding, paths like range(address=':address') have nested single quotes
    // which cause TypeScript syntax errors. Convert the path string from single quotes
    // to backticks (template literal) so single quotes can remain inside.
    // Match: path: '/...range(param=':value')...',
    // Replace with: path: `/...range(param=':value')...`,
    clientCode = clientCode.replace(/(path:\s*)'(\/[^']*\([^)]*=':[\w]+'\)[^']*)'/g, '$1`$2`');

    // openapi-zod-client emits z.instanceof(File) for `format: binary` bodies; MCP
    // transports JSON so no caller produces File. Body marshaller decodes the string.
    clientCode = clientCode.replace(
      /z\.instanceof\(File\)/g,
      "z.string().describe('Base64-encoded file content. The server decodes it and PUTs the raw bytes to Microsoft Graph.')"
    );

    fs.writeFileSync(clientFilePath, clientCode);

    // Format the generated client so `npm run generate` output is prettier-stable and
    // the format:check step in `npm run verify` passes deterministically across versions.
    // Best-effort: prettier is a devDependency, so it is absent on a production install
    // (e.g. the Databricks Apps build with NODE_ENV=production). Formatting only matters
    // for the committed-free local/CI flow, so skip it when prettier can't be resolved.
    const prettierBin = tryResolvePrettierBin();
    if (prettierBin) {
      console.log('Formatting generated client with Prettier...');
      execFileSync(process.execPath, [prettierBin, '--write', clientFilePath], {
        stdio: 'inherit',
      });
    } else {
      console.log('Prettier not installed; skipping generated-client formatting.');
    }

    return true;
  } catch (error) {
    throw new Error(`Error generating client code: ${error.message}`);
  }
}
