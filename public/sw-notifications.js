self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var scopeUrl = (self.registration && self.registration.scope) || '/';
  var targetPath =
    (event.notification && event.notification.data && event.notification.data.url) || './?tab=bills';
  var resolvedUrl = new URL(targetPath, scopeUrl).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client && 'focus' in client) {
          client.focus();
          if (client.postMessage) {
            client.postMessage({ type: 'TALA_OPEN_BILLS' });
          }
          return client;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(resolvedUrl);
      }
      return undefined;
    })
  );
});
