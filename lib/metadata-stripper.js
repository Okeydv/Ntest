const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Функция для удаления EXIF метаданных из изображений
// Будет работать с sharp после его установки
async function stripImageMetadata(inputPath, outputPath) {
    try {
        // Проверяем доступность sharp
        let sharp;
        try {
            sharp = require('sharp');
        } catch (e) {
            console.warn('[MetadataStripper] Sharp not available, copying file without metadata stripping');
            await fs.promises.copyFile(inputPath, outputPath);
            return outputPath;
        }

        // sharp по умолчанию НЕ переносит метаданные в результат, поэтому
        // «удаление» здесь — это просто отсутствие вызова withMetadata().
        //
        // Раньше тут стоял .withMetadata({ exif: {}, ... }) с комментарием
        // «удаляем все метаданные» — и делал ровно обратное. withMetadata()
        // в sharp ВКЛЮЧАЕТ перенос метаданных в результат, а exif: {}
        // подмешивает пустой набор в уже сохранённый EXIF, ничего не
        // вычищая. Замер на фото с подписью автора и моделью камеры:
        // 248 байт EXIF на входе → те же 248 байт на выходе, строки
        // «Ivan Petrov», «Canon», «EOS R5» проходили насквозь. В том же
        // блоке лежат GPS-координаты, то есть геолокация уезжала на сервер
        // и раздавалась участникам чата через /uploads/:filename.
        //
        // .rotate() без аргументов применяет EXIF Orientation к пикселям,
        // поэтому ориентация сохраняется и после того, как тег исчез.
        // Отдельная конвертация в sRGB не нужна: выходной конвейер sharp и
        // так приводит к sRGB — проверено сравнением пикселей с ICC-профилем
        // и без него, разница только в шуме квантования JPEG.
        await sharp(inputPath)
            .rotate()
            .toFile(outputPath);

        return outputPath;
    } catch (error) {
        console.error('[MetadataStripper] Error stripping metadata:', error.message);
        // В случае ошибки копируем оригинал
        await fs.promises.copyFile(inputPath, outputPath);
        return outputPath;
    }
}

// Удаление метаданных из PDF (базовая версия)
async function stripPdfMetadata(inputPath, outputPath) {
    try {
        const buffer = await fs.promises.readFile(inputPath);

        // Простое удаление стандартных PDF метаданных
        let content = buffer.toString('binary');

        // Удаляем Info dictionary
        content = content.replace(/\/Info\s+\d+\s+\d+\s+R/g, '');

        // Удаляем XMP метаданные
        content = content.replace(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g, '');

        // Записываем очищенный файл
        await fs.promises.writeFile(outputPath, Buffer.from(content, 'binary'));

        return outputPath;
    } catch (error) {
        console.error('[MetadataStripper] Error stripping PDF metadata:', error.message);
        await fs.promises.copyFile(inputPath, outputPath);
        return outputPath;
    }
}

// Универсальная функция для обработки файлов
async function stripMetadataFromFile(filePath, mimeType) {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    const dirname = path.dirname(filePath);

    // Создаем временное имя для обработанного файла
    const tempName = `${basename}-cleaned-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const tempPath = path.join(dirname, tempName);

    try {
        if (mimeType.startsWith('image/')) {
            await stripImageMetadata(filePath, tempPath);
        } else if (mimeType === 'application/pdf') {
            await stripPdfMetadata(filePath, tempPath);
        } else {
            // Для других типов файлов просто копируем
            await fs.promises.copyFile(filePath, tempPath);
        }

        // Заменяем оригинальный файл очищенной версией
        await fs.promises.unlink(filePath);
        await fs.promises.rename(tempPath, filePath);

        return filePath;
    } catch (error) {
        console.error('[MetadataStripper] Error processing file:', error.message);

        // Очищаем временный файл если он существует
        try {
            if (fs.existsSync(tempPath)) {
                await fs.promises.unlink(tempPath);
            }
        } catch (cleanupError) {
            // Игнорируем ошибки очистки
        }

        throw error;
    }
}

// Удаление временных файлов старше определенного времени
async function cleanupOldFiles(directory, maxAgeMs = 3600000) {
    try {
        const files = await fs.promises.readdir(directory);
        const now = Date.now();

        for (const file of files) {
            const filePath = path.join(directory, file);
            const stats = await fs.promises.stat(filePath);

            if (now - stats.mtimeMs > maxAgeMs) {
                await fs.promises.unlink(filePath);
                console.log('[MetadataStripper] Cleaned up old file:', file);
            }
        }
    } catch (error) {
        console.error('[MetadataStripper] Error cleaning up old files:', error.message);
    }
}

module.exports = {
    stripImageMetadata,
    stripPdfMetadata,
    stripMetadataFromFile,
    cleanupOldFiles
};
