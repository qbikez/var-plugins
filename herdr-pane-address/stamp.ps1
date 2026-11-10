# Appends the public pane address (w6:p4) to the manual label.
# A custom name is kept. A trailing address is replaced, so a move or a
# later rename does not stack stale ids. With no event payload, every pane
# is stamped. pane.created, pane.moved, and pane.focused stamp one pane.

param(
    [switch]$Test
)

$ErrorActionPreference = 'Stop'

# Herdr public ids use this alphabet. See encode_public_number in herdr.
$script:PaneIdPattern = 'w[123456789ABCDEFGHJKMNPQRSTVWXYZ0]+:p[123456789ABCDEFGHJKMNPQRSTVWXYZ0]+'

function Get-PaneLabelBase {
    param([AllowNull()][string]$Label)

    if ([string]::IsNullOrWhiteSpace($Label)) {
        return ''
    }

    $result = $Label.Trim()
    if ($result -cmatch "^$script:PaneIdPattern$") {
        return ''
    }

    $trailing = "\s+$script:PaneIdPattern$"
    while ($result -cmatch $trailing) {
        $result = ([regex]::Replace($result, $trailing, '')).TrimEnd()
        if ($result -cmatch "^$script:PaneIdPattern$") {
            return ''
        }
    }

    return $result
}

function Get-StampedPaneLabel {
    param(
        [AllowNull()][string]$Label,
        [Parameter(Mandatory)][string]$PaneId
    )

    $base = Get-PaneLabelBase $Label
    if ([string]::IsNullOrEmpty($base)) {
        return $PaneId
    }

    return "$base $PaneId"
}

function Get-HerdrPanes {
    $herdr = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
    $raw = & $herdr pane list
    if ($LASTEXITCODE -ne 0) {
        throw "herdr pane list failed: $raw"
    }

    $json = $raw | ConvertFrom-Json
    if (-not $json.result.panes) {
        return @()
    }

    return @($json.result.panes)
}

function Get-StampScope {
    param([AllowNull()][string]$EventJson)

    if ([string]::IsNullOrWhiteSpace($EventJson)) {
        return [pscustomobject]@{ All = $true; PaneId = $null }
    }

    $payload = $EventJson | ConvertFrom-Json
    $paneId = switch ($payload.event) {
        'pane_created' { [string]$payload.data.pane.pane_id }
        'pane_focused' { [string]$payload.data.pane_id }
        'pane_moved' { [string]$payload.data.pane.pane_id }
        default { $null }
    }

    if ([string]::IsNullOrWhiteSpace($paneId)) {
        return [pscustomobject]@{ All = $false; PaneId = $null }
    }

    return [pscustomobject]@{ All = $false; PaneId = $paneId }
}

function Update-PaneAddressLabel {
    param($Pane)

    $paneId = [string]$Pane.pane_id
    $current = [string]$Pane.label
    if ($null -eq $Pane.label) {
        $current = ''
    }

    $desired = Get-StampedPaneLabel -Label $current -PaneId $paneId
    if ([string]::Equals($desired, $current, [StringComparison]::Ordinal)) {
        return $false
    }

    $herdr = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
    & $herdr pane rename $paneId $desired | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "herdr pane rename $paneId failed"
    }

    return "${paneId}: $current -> $desired"
}

function Invoke-SelfTest {
    $cases = @(
        @{ Label = $null; Id = 'w6:p4'; Expected = 'w6:p4' },
        @{ Label = ''; Id = 'w6:p4'; Expected = 'w6:p4' },
        @{ Label = 'build'; Id = 'w6:p4'; Expected = 'build w6:p4' },
        @{ Label = 'build w6:p4'; Id = 'w6:p4'; Expected = 'build w6:p4' },
        @{ Label = 'build w2:p1'; Id = 'w6:p4'; Expected = 'build w6:p4' },
        @{ Label = 'w2:pE'; Id = 'w6:p4'; Expected = 'w6:p4' },
        @{ Label = 'build w2:p1 wA:p1'; Id = 'wC:p2'; Expected = 'build wC:p2' },
        @{ Label = 'retry-resilience-testing'; Id = 'w3:p1'; Expected = 'retry-resilience-testing w3:p1' },
        @{ Label = 'notes w9'; Id = 'w2:p1'; Expected = 'notes w9 w2:p1' }
    )

    $failed = 0
    foreach ($case in $cases) {
        $actual = Get-StampedPaneLabel -Label $case.Label -PaneId $case.Id
        if ($actual -cne $case.Expected) {
            Write-Error "label '$($case.Label)' id $($case.Id): got '$actual', expected '$($case.Expected)'"
            $failed++
        }
    }

    $all = Get-StampScope $null
    $one = Get-StampScope '{"event":"pane_focused","data":{"type":"pane_focused","pane_id":"w6:p4","workspace_id":"w6"}}'
    $moved = Get-StampScope '{"event":"pane_moved","data":{"type":"pane_moved","previous_pane_id":"w2:p1","previous_workspace_id":"w2","previous_tab_id":"w2:t1","pane":{"pane_id":"w6:p4"}}}'
    $skip = Get-StampScope '{"event":"pane_closed","data":{"type":"pane_closed","pane_id":"w6:p4","workspace_id":"w6"}}'
    if (-not $all.All -or $one.PaneId -cne 'w6:p4' -or $one.All -or $moved.PaneId -cne 'w6:p4' -or $skip.All -or $skip.PaneId) {
        Write-Error "stamp scope mismatch: all=$($all.All) one=$($one.PaneId) moved=$($moved.PaneId) skipAll=$($skip.All) skipId=$($skip.PaneId)"
        $failed++
    }

    if ($failed -gt 0) {
        exit 1
    }

    Write-Output "ok $($cases.Count)"
}

if ($Test) {
    Invoke-SelfTest
    exit 0
}

$scope = Get-StampScope $env:HERDR_PLUGIN_EVENT_JSON
if (-not $scope.All -and -not $scope.PaneId) {
    exit 0
}

$panes = Get-HerdrPanes
if (-not $scope.All) {
    $panes = @($panes | Where-Object { $_.pane_id -ceq $scope.PaneId })
}

$errors = @()
foreach ($pane in $panes) {
    if (-not $pane) {
        continue
    }

    try {
        $changed = Update-PaneAddressLabel $pane
        if ($changed) {
            Write-Output $changed
        }
    }
    catch {
        $message = $_.Exception.Message
        $errors += $message
        [Console]::Error.WriteLine($message)
    }
}

if ($errors.Count -gt 0) {
    exit 1
}
