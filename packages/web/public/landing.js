// Live signal: is a local `idel serve` actually backing this page?
const status = document.getElementById("server-status");

fetch("/api/health")
  .then((response) => (response.ok ? response.json() : Promise.reject(new Error("offline"))))
  .then((data) => {
    if (!status) return;
    status.textContent = "● local runtime online — idel " + (data.version || "");
    status.classList.add("online");
  })
  .catch(() => {
    if (!status) return;
    status.textContent =
      "○ no local runtime detected — run `idel serve --static …` to power the terminal";
  });
