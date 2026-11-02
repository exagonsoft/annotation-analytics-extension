import { createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import yazl from 'yazl';

await mkdir('artifacts', { recursive: true });
const zip = new yazl.ZipFile();
async function add(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const local = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await add(local, name);
    else zip.addFile(local, name);
  }
}
await add('dist');
const output = createWriteStream(join('artifacts', 'annotation-analytics-1.0.0.zip'));
zip.outputStream.pipe(output);
zip.end();
await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); zip.outputStream.on('error', reject); });
console.log('Packaged artifacts/annotation-analytics-1.0.0.zip');
