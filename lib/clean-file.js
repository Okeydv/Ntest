'use strict';

// Процесс очистки загруженного файла (см. lib/limited-process.js).
const { stripMetadataFromFile } = require('./metadata-stripper');

process.once('message', ({ filePath, mimeType }) => {
    stripMetadataFromFile(filePath, mimeType).then(
        () => process.send({ ok: true }, () => process.exit(0)),
        error => process.send({ ok: false, name: error.name, message: error.message }, () => process.exit(0)),
    );
});
