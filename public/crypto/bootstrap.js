// Мост между ES-модулями крипты и script.js, который остаётся обычным
// скриптом с глобальными функциями.
//
// Модульные скрипты всегда deferred, то есть выполняются ПОЗЖЕ обычного
// script.js. Поэтому здесь не просто присваивается window.NyxoCrypto, но и
// рассылается событие: script.js может подписаться на него независимо от
// того, кто успел первым.

import * as client from './client.js';

window.NyxoCrypto = client;
window.dispatchEvent(new Event('nyxo-crypto-ready'));
