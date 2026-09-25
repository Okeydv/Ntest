// Модули, общие для браузера и сервера, лежат в public/crypto как
// ES-модули. Сервер — CommonJS, поэтому подключает их через import(), один
// раз на процесс.

const path = require('path');
const { pathToFileURL } = require('url');

const cache = new Map();

function shared(name) {
    if (!cache.has(name)) {
        cache.set(name, import(pathToFileURL(path.join(__dirname, '..', 'public', 'crypto', name)).href));
    }
    return cache.get(name);
}

module.exports = { shared };
