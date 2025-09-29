# Parameters
$sourceDir = "C:\path\to\tdf\game\files"                                            # source directory
$logFile = "C:\path\to\UploadGames.log"                                             # file to save logs into
$fileType = "*.tdf"                                                                 # file type to upload
$cutoff = (Get-Date).AddMinutes(-15)                                                # only upload files modified in the last 3 hours

# AWS Stuff
$env:AWS_ACCESS_KEY_ID     = "AKxxx"
$env:AWS_SECRET_ACCESS_KEY = "xxxxx"
$env:AWS_DEFAULT_REGION    = "ap-southeast-2"
$bucket = "bucket-name"
$prefix = "upload-folder/"

"=== Run started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content -Path $logFile

Get-ChildItem -Path $sourceDir -Filter $fileType | Where-Object {
    $_.LastWriteTime -gt $cutoff } | ForEach-Object {
    $msg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Uploading file $($_.FullName)..."
    Add-Content -Path $logFile -Value $msg
    $result = aws s3 cp $_.FullName "s3://$bucket/$prefix"
    Add-Content -Path $logFile -Value $result
}