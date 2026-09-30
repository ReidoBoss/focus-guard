// Windows only. The limiter runs as SYSTEM, which can't show notifications on your
// desktop, so this runs in your session and turns its notices into Windows toasts.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

let port = 43210;
try {
  port = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")).port || port;
} catch (e) {}

const TOAST = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName("text")
$x.Item(0).AppendChild($t.CreateTextNode($env:FG_TITLE)) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode($env:FG_MSG)) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;

function toast(title, msg) {
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", TOAST], {
    windowsHide: true,
    env: Object.assign({}, process.env, { FG_TITLE: title, FG_MSG: msg }),
  }, () => {});
}

let after = Date.now();

function poll() {
  http
    .get(`http://127.0.0.1:${port}/notices?after=${after}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          for (const n of JSON.parse(data)) {
            after = Math.max(after, n.id);
            toast(n.title, n.msg);
          }
        } catch (e) {}
      });
    })
    .on("error", () => {});
}

setInterval(poll, 3000);
