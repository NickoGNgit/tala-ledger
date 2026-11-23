import './firebaseSync';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.PROD) {
      let hasController = Boolean(navigator.serviceWorker.controller);
      let refreshing = false;

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hasController) {
          hasController = true;
          return;
        }
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });

      navigator.serviceWorker
        .register('./sw.js', {scope: './', updateViaCache: 'none'})
        .then((reg) => {
          const checkUpdate = () => {
            void reg.update().catch(() => {});
          };
          checkUpdate();
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              checkUpdate();
            }
          });
          window.addEventListener('online', checkUpdate);
        })
        .catch(() => {});
    } else {
      navigator.serviceWorker
        .register('/dev-sw.js?dev-sw', {scope: '/', type: 'classic'})
        .catch(() => {});
    }
  });
}
