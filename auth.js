(async () => {
  const status = document.getElementById("status");
  if (location.hash === "#done") {
    status.textContent = "Signed in successfully. You can close this tab and reopen the extension.";
    setTimeout(() => window.close(), 1200);
    return;
  }
  try {
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      const message = { type: "auth:complete", callback: location.href };
      try {
        const pending = chrome.runtime.sendMessage(message, value => {
          const failure = chrome.runtime.lastError;
          finish(failure ? new Error(failure.message) : null, value);
        });
        if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
      } catch {
        const pending = chrome.runtime.sendMessage(message);
        if (pending?.then) pending.then(value => finish(null, value)).catch(error => finish(error));
        else finish(null, pending);
      }
    });
    if (response?.ok === false) throw new Error(response.error);
    status.textContent = "Signed in successfully. You can close this tab and reopen the extension.";
    setTimeout(() => window.close(), 1200);
  } catch (error) {
    status.textContent = error?.message || "Google sign-in could not be completed.";
  }
})();
