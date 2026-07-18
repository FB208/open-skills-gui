/** 延迟 skills@1.5.19 的强制退出，等待 Windows 网络句柄完成关闭。 */
const exitImmediately = process.exit.bind(process);
let exitScheduled = false;

process.exit = (code) => {
  if (typeof code === 'number') process.exitCode = code;
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => exitImmediately(process.exitCode ?? 0), 250);
};
