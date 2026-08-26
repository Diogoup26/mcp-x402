[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StartUtc,

    [Parameter(Mandatory = $true)]
    [string]$EndUtc,

    [string]$OutputPrefix = "railway-window",
    [string]$Service = "mcp-x402",
    [string]$Environment = "production",
    [int]$MaxLines = 5000,
    [string]$RailwayCommand = "railway.cmd"
)

$ErrorActionPreference = "Stop"

function Get-TimePrefix([string]$Value, [string]$Name) {
    if ($Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}') {
        throw "$Name must be an ISO-8601 timestamp, for example 2026-08-24T15:44:11Z."
    }
    return $Value.Substring(0, 19)
}

$startPrefix = Get-TimePrefix $StartUtc "StartUtc"
$endPrefix = Get-TimePrefix $EndUtc "EndUtc"
if ([string]::CompareOrdinal($startPrefix, $endPrefix) -gt 0) {
    throw "StartUtc must not be later than EndUtc."
}
if ($MaxLines -lt 1) {
    throw "MaxLines must be greater than zero."
}

function Get-RecordTimestamp($Record) {
    foreach ($name in @("timestamp", "time", "createdAt", "eventTimestamp")) {
        $property = $Record.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return [string]$property.Value
        }
    }
    return $null
}

function Export-LogKind([string]$Kind, [bool]$Http) {
    $rawPath = "$OutputPrefix-$Kind.raw.ndjson"
    $boundedPath = "$OutputPrefix-$Kind.ndjson"
    $arguments = @(
        "logs",
        "--service", $Service,
        "--environment", $Environment,
        "--since", $StartUtc,
        "--lines", [string]$MaxLines,
        "--json"
    )
    if ($Http) {
        $arguments = @("logs", "--http") + $arguments[1..($arguments.Length - 1)]
    }

    & $RailwayCommand @arguments 2>&1 | Set-Content -LiteralPath $rawPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "Railway export for $Kind failed with exit code $LASTEXITCODE. Inspect $rawPath."
    }

    $selected = New-Object System.Collections.Generic.List[string]
    $invalid = 0
    $withoutTimestamp = 0
    $afterEnd = 0
    $beforeStart = 0

    foreach ($line in Get-Content -LiteralPath $rawPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $record = $line | ConvertFrom-Json
        }
        catch {
            $invalid += 1
            continue
        }

        $timestamp = Get-RecordTimestamp $record
        if ([string]::IsNullOrWhiteSpace($timestamp) -or $timestamp.Length -lt 19) {
            $withoutTimestamp += 1
            continue
        }
        $prefix = $timestamp.Substring(0, 19)
        if ([string]::CompareOrdinal($prefix, $startPrefix) -lt 0) {
            $beforeStart += 1
            continue
        }
        if ([string]::CompareOrdinal($prefix, $endPrefix) -gt 0) {
            $afterEnd += 1
            continue
        }
        $selected.Add($line)
    }

    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines((Join-Path (Get-Location) $boundedPath), $selected, $utf8WithoutBom)

    return [pscustomobject]@{
        Kind = $Kind
        RawFile = $rawPath
        BoundedFile = $boundedPath
        SelectedLines = $selected.Count
        InvalidRawLines = $invalid
        MissingTimestamp = $withoutTimestamp
        BeforeStart = $beforeStart
        AfterEnd = $afterEnd
    }
}

$results = @(
    Export-LogKind "app" $false
    Export-LogKind "http" $true
)

$results | Format-Table -AutoSize
Write-Host "Export complete. The script deliberately avoids Railway's broken --until flag and applies the UTC end bound locally."
