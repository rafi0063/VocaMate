// Membuka side panel VocaMate saat ikon ekstensi diklik.
// Panel tidak terikat ke satu tab, sehingga sesi tetap berjalan saat berpindah tab (FR-06).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
