#define AppName "Open Skills GUI"
#define AppVersion "1.0.0"
#define AppId "io.github.fb208.openskillsgui"
#define InnoVersion "6.7.3"
#define InstallerName "OpenSkillsGUI-Setup-x64"

#ifndef SourceRoot
  #define SourceRoot ".."
#endif
#ifndef DistributionDir
  #define DistributionDir SourceRoot + "\installer\output\app-dist"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=FB208
AppPublisherURL=https://github.com/FB208/open-skills-gui
AppSupportURL=https://github.com/FB208/open-skills-gui/issues
AppUpdatesURL=https://github.com/FB208/open-skills-gui/releases
DefaultDirName={localappdata}\Programs\OpenSkillsGUI
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19045
OutputDir={#SourceRoot}\installer\output
OutputBaseFilename={#InstallerName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=no
SetupLogging=yes
RedirectionGuard=yes
LicenseFile={#SourceRoot}\LICENSE
UninstallDisplayIcon={app}\OpenSkillsGUI.exe
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoDescription=Windows Skill 管理客户端

[Languages]
Name: "chinesesimp"; MessagesFile: "{#SourceRoot}\installer\languages\ChineseSimplified.isl"

[Files]
Source: "{#DistributionDir}\OpenSkillsGUI-win_x64.exe"; DestDir: "{app}"; DestName: "OpenSkillsGUI.exe"; Flags: ignoreversion
Source: "{#DistributionDir}\*"; Excludes: "OpenSkillsGUI-win_x64.exe"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\scripts\runtime-bootstrap.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceRoot}\scripts\runtime-manifest.json"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceRoot}\scripts\restart-manager.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceRoot}\scripts\software-update.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\OpenSkillsGUI.exe"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\OpenSkillsGUI.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Run]
Filename: "{app}\OpenSkillsGUI.exe"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\runtime"
Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\cache"
Type: filesandordirs; Name: "{localappdata}\OpenSkillsGUI\updates"

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';
  WebView2BootstrapperName = 'MicrosoftEdgeWebview2Setup.exe';

// 判断 WebView2 版本值是否表示有效安装。
function IsValidWebViewVersion(const Version: String): Boolean;
begin
  Result := (Version <> '') and (Version <> '0.0.0.0');
end;

// 从当前用户或本机注册表检查 WebView2。
function IsWebView2Installed: Boolean;
var
  Version: String;
  ClientKey: String;
begin
  ClientKey := 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId;
  Result := RegQueryStringValue(HKCU, ClientKey, 'pv', Version) and IsValidWebViewVersion(Version);
  if not Result then
    Result := RegQueryStringValue(HKLM32, ClientKey, 'pv', Version) and IsValidWebViewVersion(Version);
end;

// 记录 WebView2 下载进度并继续下载。
function OnWebViewDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if ProgressMax > 0 then
    Log(Format('WebView2 download: %d/%d', [Progress, ProgressMax]));
  Result := True;
end;

// 下载并静默安装 WebView2，然后等待注册表就绪。
function InstallWebView2: Boolean;
var
  BootstrapperPath: String;
  ResultCode: Integer;
  Retry: Integer;
begin
  Result := False;
  try
    DownloadTemporaryFile(WebView2BootstrapperUrl, WebView2BootstrapperName, '', @OnWebViewDownloadProgress);
    BootstrapperPath := ExpandConstant('{tmp}\') + WebView2BootstrapperName;
    if not Exec(BootstrapperPath, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      exit;
    if ResultCode <> 0 then
    begin
      Log(Format('WebView2 installer exit code: %d', [ResultCode]));
      exit;
    end;
    for Retry := 1 to 20 do
    begin
      if IsWebView2Installed then
      begin
        Result := True;
        exit;
      end;
      Sleep(500);
    end;
  except
    Log('WebView2 installation error: ' + GetExceptionMessage);
  end;
end;

// 安装开始前确保 WebView2 可用或终止安装。
function InitializeSetup: Boolean;
begin
  Result := True;
  if IsWebView2Installed then
    exit;

  if WizardSilent then
  begin
    Log('WebView2 is required but missing during silent setup.');
    Result := False;
    exit;
  end;

  if MsgBox('Open Skills GUI 需要 Microsoft Edge WebView2 Runtime。是否立即从微软官方下载并安装？', mbConfirmation, MB_YESNO) <> IDYES then
  begin
    MsgBox('缺少 WebView2，无法继续安装。', mbError, MB_OK);
    Result := False;
    exit;
  end;

  Result := InstallWebView2;
  if not Result then
    MsgBox('WebView2 下载或安装失败，Open Skills GUI 安装已终止。', mbError, MB_OK);
end;
