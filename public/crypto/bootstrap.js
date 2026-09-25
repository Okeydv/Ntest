// Мост между ES-модулями крипты и script.js, который остаётся обычным
// скриптом с глобальными функциями.
//
// Модульные скрипты всегда deferred, то есть выполняются ПОЗЖЕ обычного
// script.js. Поэтому здесь не просто присваивается window.NyxoCrypto, но и
// рассылается событие: script.js может подписаться на него независимо от
// того, кто успел первым.

import * as client from './client.js';
import * as attachments from './attachments.js';
import { formatSafetyNumber } from './safety.js';

// Одним объектом: script.js не должен знать, в каком из модулей что лежит.
window.NyxoCrypto = Object.freeze({ ...client, ...attachments, formatSafetyNumber });
window.dispatchEvent(new Event('nyxo-crypto-ready'));
