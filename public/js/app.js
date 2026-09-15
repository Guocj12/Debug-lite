'use strict';
/* public/js/app.js —— 启动骨架（R0）：util/log 引导即启动（spec §1.3 步骤1）。
 * store / views / mount 于 R1+ 逐批接线；本文件保持无副作用可测（bootLogging 永不抛错）。
 */
import { bootLogging } from './util/log.js';

export function start() {
  bootLogging();
}

start();
