const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Очистка работает по принципу fail closed: если снять метаданные не
// удалось, функция бросает исключение, и файл не отправляется. Раньше в
// этом случае копировался оригинал — то есть при любом сбое фото уходило
// собеседникам вместе с GPS-координатами, а пользователь об этом не знал.

// Удаление EXIF и прочих метаданных из изображений.
async function stripImageMetadata(inputPath, outputPath) {
    const sharp = require('sharp');
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
}

/**
 * Удаление метаданных из PDF: словаря Info (автор, программа, даты) и
 * XMP-пакетов.
 *
 * Документ разбирается и сохраняется заново библиотекой pdf-lib. Раньше
 * здесь были регулярные выражения по байтам файла, и они делали две вещи
 * не так:
 *   - вырезание XMP сдвигало все последующие объекты, а таблица xref
 *     продолжала указывать на старые смещения — PDF получался битым;
 *   - из трейлера убиралась только ССЫЛКА на словарь Info, а сам словарь
 *     с именем автора оставался в файле.
 * Пересохранение строит таблицу xref заново, а объекты метаданных удаляются
 * целиком, а не отвязываются.
 *
 * Зашифрованный PDF разобрать нельзя — он не отправляется (fail closed).
 */
async function stripPdfMetadata(inputPath, outputPath) {
    const { PDFDocument, PDFName, PDFDict, PDFRef } = require('pdf-lib');
    const bytes = await fs.promises.readFile(inputPath);
    // updateMetadata: false — иначе pdf-lib сам допишет Producer и даты.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const context = doc.context;

    const info = context.trailerInfo.Info;
    if (info instanceof PDFRef) context.delete(info);
    context.trailerInfo.Info = undefined;

    // XMP бывает не только у каталога, но и у страниц, шрифтов, картинок:
    // удаляем все потоки типа Metadata и ссылки на них.
    const METADATA = PDFName.of('Metadata');
    const TYPE = PDFName.of('Type');
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        const dict = obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);
        if (!dict) continue;
        if (dict.get(TYPE) === METADATA) {
            context.delete(ref);
            continue;
        }
        dict.delete(METADATA);
    }

    await fs.promises.writeFile(outputPath, await doc.save({ useObjectStreams: false }));
    return outputPath;
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

module.exports = {
    stripImageMetadata,
    stripPdfMetadata,
    stripMetadataFromFile,
};
