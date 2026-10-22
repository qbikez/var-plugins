$targets = @{
    "restore" = {
        bun install
    }

    "build"   = {
        # Bun runs the TypeScript directly, so "build" is a typecheck plus a manifest sanity check.
        bun install --frozen-lockfile
        bun run typecheck
        if ($LASTEXITCODE) { throw "typecheck failed" }
        $version = (Get-Content "$PSScriptRoot/package.json" -Raw | ConvertFrom-Json).version
        if ((Get-Content "$PSScriptRoot/herdr-plugin.toml" -Raw) -notmatch "(?m)^version = `"$([regex]::Escape($version))`"") {
            throw "herdr-plugin.toml version does not match package.json ($version)"
        }
    }

    "run"     = {
        param([switch][bool] $dry, [ValidateSet(1, 2)][int] $machine)
        # The daemon needs herdr's socket. Inside a herdr pane run it directly (foreground), otherwise open the plugin's pane.
        if ($env:HERDR_SOCKET_PATH) {
            $flags = @()
            if ($dry) { $flags += "--dry-run" }
            if ($machine) { $flags += "--machine", $machine }
            bun src/main.ts @flags
        }
        else {
            if ($dry -or $machine) { Write-Warning "-dry/-machine only apply inside a herdr pane; set machine in config.json for the plugin pane" }
            qbuild link
            herdr plugin pane open --plugin qbikez.chroma --entrypoint daemon
        }
    }

    "link"    = {
        # Register this checkout as a local plugin (no build commands run).
        herdr plugin link $PSScriptRoot
    }

    "install"  = {
        param([switch][bool] $github, [string] $ref)
        # Default: install this checkout (typechecked) as a linked local plugin.
        # -github: install the published plugin the way end users do, optionally pinned with -ref.
        foreach ($tool in "bun", "herdr") {
            if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found on PATH" }
        }
        if ($github) {
            $refArgs = $ref ? @("--ref", $ref) : @()
            herdr plugin install qbikez/foundry/herdr-chroma-plugin @refArgs
        }
        else {
            if ($ref) { throw "-ref only applies with -github" }
            qbuild build
            qbuild link
        }
    }

    "release" = {
        param(
            [ValidateSet("patch", "minor", "major")][string] $bump = "patch",
            [string] $version,
            [switch][bool] $push
        )
        # Bumps package.json + herdr-plugin.toml, commits, and tags `herdr-chroma-v<version>`.
        # Users install the default branch, or pin the tag: herdr plugin install qbikez/foundry/herdr-chroma-plugin --ref <tag>
        # Nothing leaves the machine unless -push is given.
        Push-Location $PSScriptRoot
        try {
            if (git status --porcelain -- .) { throw "uncommitted changes in herdr-chroma-plugin; commit or stash them first" }

            $pkgPath = "package.json"
            $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
            if (-not $version) {
                $v = [version]$pkg.version
                $version = switch ($bump) {
                    "major" { "$($v.Major + 1).0.0" }
                    "minor" { "$($v.Major).$($v.Minor + 1).0" }
                    default { "$($v.Major).$($v.Minor).$($v.Build + 1)" }
                }
            }
            if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "version must be x.y.z, got '$version'" }
            $tag = "herdr-chroma-v$version"
            if (git tag --list $tag) { throw "tag $tag already exists" }

            $old = $pkg.version
            (Get-Content $pkgPath -Raw) -replace "(?m)^(\s*`"version`": `")[^`"]+", "`${1}$version" | Set-Content $pkgPath -NoNewline
            (Get-Content herdr-plugin.toml -Raw) -replace '(?m)^version = ".*"', "version = `"$version`"" | Set-Content herdr-plugin.toml -NoNewline

            qbuild build
            git add package.json herdr-plugin.toml
            git commit -m "herdr-chroma-plugin: release $version"
            git tag $tag
            Write-Host "Released $old -> $version (tag $tag)"

            if ($push) {
                git push origin HEAD $tag
            }
            else {
                Write-Host "Not pushed. Run: git push origin HEAD $tag"
            }
        }
        finally { Pop-Location }
    }
}

return $targets
