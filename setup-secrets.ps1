# Traegt alle Zugangsdaten fuer den TikTok-Autoposter ein: Autoposter-Worker, GitHub-Repo und Website-Worker.
# Fragt die TikTok Production Credentials und den OpenAI-Key ab, alles andere kommt aus SECRETS-LOKAL.txt.
# Aufruf im Ordner tiktok-autoposter:  powershell -ExecutionPolicy Bypass -File setup-secrets.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$vals = @{}
Get-Content "SECRETS-LOKAL.txt" | Where-Object { $_ -match "^[A-Z_]+=" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    $vals[$k] = $v
}

# Asks until a non-empty value is pasted; an empty secret would silently break the TikTok login.
function Ask([string]$label) {
    while ($true) {
        $s = Read-Host -AsSecureString "$label (einfuegen mit Rechtsklick, dann Enter)"
        $v = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
        if ($v.Length -ge 8) { Write-Host "  ok ($($v.Length) Zeichen)" -ForegroundColor Green; return $v }
        Write-Host "  Leer oder zu kurz, bitte den Wert einfuegen." -ForegroundColor Red
    }
}

Write-Host "TikTok Developer Portal > Production > Credentials" -ForegroundColor Yellow
$vals["TIKTOK_CLIENT_KEY"] = Ask "Production Client key"
$vals["TIKTOK_CLIENT_SECRET"] = Ask "Production Client secret"
$openai = Ask "OpenAI API key (wie beim Instagram-Poster)"

Write-Host "`n1/3 Cloudflare Worker" -ForegroundColor Cyan
Push-Location worker
foreach ($k in "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "DASHBOARD_PASSWORD", "APP_SECRET", "AUTOPOSTER_SECRET") {
    $vals[$k] | npx wrangler secret put $k | Out-Null
    Write-Host "  $k gesetzt"
}
Pop-Location

Write-Host "`n2/3 GitHub Actions" -ForegroundColor Cyan
$openai | gh secret set OPENAI_API_KEY --repo xenoblade1234/tiktok-autoposter
$vals["AUTOPOSTER_URL"] | gh secret set AUTOPOSTER_URL --repo xenoblade1234/tiktok-autoposter
$vals["AUTOPOSTER_SECRET"] | gh secret set AUTOPOSTER_SECRET --repo xenoblade1234/tiktok-autoposter
Write-Host "  OPENAI_API_KEY, AUTOPOSTER_URL, AUTOPOSTER_SECRET gesetzt"

Write-Host "`n3/3 Website-Worker viennawebdesigns.com (TikTok-Login)" -ForegroundColor Cyan
foreach ($k in "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "AUTOPOSTER_URL", "AUTOPOSTER_SECRET") {
    $vals[$k] | npx wrangler secret put $k --name viennawebdesigns | Out-Null
    Write-Host "  $k gesetzt"
}

Write-Host "`nFertig. Dashboard: $($vals["AUTOPOSTER_URL"])" -ForegroundColor Green
Write-Host "Passwort steht in SECRETS-LOKAL.txt (DASHBOARD_PASSWORD)."
