const sourcePath = new URL('../public/sw.js', import.meta.url);
const outputPath = new URL('../../public/sw.js', import.meta.url);
const source = await Bun.file(sourcePath).text();

if (!source.includes('__DKRYPT_BUILD__')) throw new Error('service worker build marker is missing');

await Bun.write(outputPath, source.replaceAll('__DKRYPT_BUILD__', String(Date.now())));
