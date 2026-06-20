const fs = require('fs');
const acorn = require('acorn');
for (const file of fs.readdirSync('frontend/js')) {
  if (!file.endsWith('.js')) continue;
  try {
    acorn.parse(fs.readFileSync('frontend/js/' + file, 'utf8'), { ecmaVersion: 2022, sourceType: 'module' });
  } catch (e) {
    console.error('Error in ' + file + ':', e.message);
  }
}
