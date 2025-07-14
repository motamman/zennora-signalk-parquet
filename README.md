# Zennora SignalK to Parquet Plugin

A SignalK Node.js plugin that saves signalk vessel data directly to Parquet files with regimen-based control. This words with the Zennora zennora-signalk-register-commands plugin but any bool path can be used.

## Features

- **Direct SignalK Integration**: Subscribe directly to SignalK data streams.
- **Parquet File Format**: Native Parquet support with DuckDB compatibility for efficient marine data analysis
- **Regimen-Based Control**: Dynamic data collection based on vessel activity commands with automatic startup activation
- **Source Filtering**: Control which devices/plugins can activate data collection regimens
- **Efficient Buffering**: Per-path buffering with configurable sizes and save intervals
- **Daily Consolidation**: Automatic file merging and cleanup
- **Web Configuration**: Easy web interface for configuring SignalK paths and regimens
- **Query Web Interface**: Dedicated web app for exploring and querying Parquet data with DuckDB
- **Compatible Schema**: Maintains same data structure as signalk context and path structue

## Installation



```bash
cd ~/.signalk/
npm install @motamman/zennora-signalk-parquet
```

Then restart SignalK server:
```bash
sudo systemctl restart signalk
```

**Dependencies**: The plugin automatically installs all required dependencies:
- `@dsnp/parquetjs` - for native Parquet file writing with DuckDB compatibility
- `@duckdb/node-api` - for webapp SQL query interface (REQUIRED for web interface)
- `@aws-sdk/client-s3` - for optional S3 cloud backup functionality
- `fs-extra` - for enhanced file operations
- `glob` - for file pattern matching

**Note**: If `@duckdb/node-api` installation fails, the webapp query interface will not work (but data collection will still function). If Parquet dependencies fail, the plugin will fall back to JSON format with a warning. Failed Parquet writes are saved to a separate `/failed/` directory to maintain DuckDB schema consistency.

## Configuration

1. Navigate to SignalK Admin UI → Server Configuration → Plugins
2. Find "Zennora SignalK to Parquet" and enable it
3. Click **Configure** to set up data collection

### Configuration Options

- **Buffer Size**: Number of records to buffer before writing (default: 1000)
- **Save Interval**: How often to save buffered data in seconds (default: 30)
- **Output Directory**: Where to save data files (default: 'data')
- **Filename Prefix**: Prefix for generated files (default: 'signalk_data')
- **File Format**: Choose JSON, CSV, or Parquet format (default: Parquet)
- **Retention Days**: Days to keep processed files (default: 7)
- **Paths**: Configure which SignalK paths to collect

## Regimen System

The plugin supports the same regimen-based control as the Python version:

### Command Paths
- `vessels.self.commands.captureWeather` - Environmental data collection
- `vessels.self.commands.capturePassage` - Navigation and passage data
- `vessels.self.commands.captureAnchor` - Anchoring and stationary data
- `vessels.self.commands.captureAIS` - Nearby vessels. (Strong recommend derived data plugin)

### How It Works
1. Command paths are always monitored for changes
2. When a command changes (true/false), data subscriptions update automatically
3. Data paths with matching regimens are enabled/disabled dynamically
4. Multiple regimens can control a single path: `"captureWeather, capturePassage"`
5. **Automatic Startup**: Plugin reads current command states from SignalK API at startup
6. **Source Filtering**: Optional source filtering to control which devices can activate regimens

## Data Schema

| Column | Description |
|--------|-------------|
| `received_timestamp` | When message was received by plugin |
| `signalk_timestamp` | Original SignalK timestamp |
| `context` | SignalK context (usually "vessels.self") |
| `path` | SignalK data path |
| `value` | Simple numeric/string values |
| `value_json` | Complex values stored as JSON |
| `value_*` | Flattened fields from complex values |
| `source` | Complete source information as JSON |
| `source_label` | Source device label |
| `source_type` | Source device type |
| `source_pgn` | NMEA 2000 PGN (if applicable) |
| `source_src` | Source address |
| `meta` | SignalK metadata as JSON |

## File Structure


```
data/
├── vessels/self/navigation/position/
│   ├── signalk_data_20250702_143022.parquet    # Timestamped files
│   ├── signalk_data_2025-07-02_consolidated.parquet  # Daily consolidated
│   └── processed/                              # Processed files
└── vessels/self/environment/wind/speedApparent/
    ├── signalk_data_20250702_143022.parquet
    └── processed/
```

```python query example
import duckdb

# Query Parquet files directly with DuckDB
conn = duckdb.connect()
df = conn.execute("""
    SELECT path, value, received_timestamp, source_label
    FROM '~/.signalk/data/vessels/self/environment/wind/speedApparent/signalk_data_2025-07-02_consolidated.parquet'
    WHERE value IS NOT NULL
""").df()

print(f"Average wind speed: {df['value'].mean():.2f} m/s")
```

## Configuration Examples

### Basic Weather Monitoring
```json
{
  "name": "Wind Speed Apparent",
  "path": "environment.wind.speedApparent",
  "enabled": false,
  "regimen": "captureWeather"
}
```

### Source Filtering Example
```json
{
  "name": "Capture Weather Command",
  "path": "commands.captureWeather",
  "enabled": true,
  "source": "zennora-signalk-register-commands.XX"
}
```

This configuration ensures only commands from the specified source device can activate data collection regimens, providing security control over data collection.

## Query Web Interface

The plugin includes an integrated SignalK webapp for exploring and querying your Parquet data:

### Access

Once the plugin is installed and enabled, the web interface is automatically available at:
- **https://your-signalk-server:3443/plugins/zennora-signalk-parquet/**
- **http://localhost:3443/plugins/zennora-signalk-parquet/** (if running locally)

Replace `your-signalk-server` with your actual SignalK server hostname or IP address.

### Features

- **🔍 Interactive Query Builder**: Write custom DuckDB SQL queries directly
- **📊 Real-time Results**: Fast querying with tabular results display
- **📝 Manual Query Interface**: Enter SQL queries for any Parquet data path
- **📱 Responsive Design**: Works on desktop and mobile devices
- **🎯 Direct File Access**: Query Parquet files using full file paths
- **☁️ S3 Configuration Panel**: Test S3 connections and understand Key Prefix functionality

### Example Queries

**Wind Speed Analysis:**
```sql
SELECT * FROM '~/.signalk/data/vessels/urn_mrn_imo_mmsi_368396230/environment/outside/rapidWind/windSpeed/*.parquet'
ORDER BY received_timestamp DESC 
LIMIT 10;
```

**Position Data (Single File):**
```sql
SELECT * FROM '~/.signalk/data/vessels/urn_mrn_imo_mmsi_368396230/navigation/position/signalk_data_2025-07-03T1200.parquet'
LIMIT 5;
```

**Position Data (Specific Columns to Avoid Schema Issues):**
```sql
SELECT received_timestamp, signalk_timestamp, value_latitude, value_longitude, source_label
FROM '~/.signalk/data/vessels/urn_mrn_imo_mmsi_368396230/navigation/position/*.parquet'
WHERE value_latitude IS NOT NULL
ORDER BY received_timestamp DESC 
LIMIT 10;
```

**Filter by Source:**
```sql
SELECT * FROM '~/.signalk/data/vessels/urn_mrn_imo_mmsi_368396230/navigation/position/*.parquet'
WHERE source_label = 'mqtt-navBasic'
ORDER BY received_timestamp DESC 
LIMIT 10;
```

### Troubleshooting Queries

**Schema Mismatch Errors:**
If you get "TProtocolException: Invalid data" when using wildcards (`*.parquet`), this indicates schema differences between files from different data sources. Solutions:

1. **Query specific columns that exist in all files:**
   ```sql
   SELECT received_timestamp, value_latitude, value_longitude 
   FROM '/path/to/files/*.parquet'
   WHERE value_latitude IS NOT NULL;
   ```

2. **Filter by specific source to ensure schema consistency:**
   ```sql
   SELECT * FROM '/path/to/files/*.parquet'
   WHERE source_label = 'your-source-name';
   ```

3. **Query individual files when schemas vary:**
   ```sql
   SELECT * FROM '/path/to/specific/file.parquet';
   ```

**Finding Your Data Paths:**
```bash
find ~/.signalk/data/vessels/self -name "*.parquet" -type f | head -10
```

### S3 Configuration Panel

The webapp includes an S3 configuration section for testing connections and understanding the Key Prefix functionality:

#### Test S3 Connection

Click the **🔗 Test S3 Connection** button to verify your S3 configuration. The test will:
- Verify your AWS credentials are working
- Check that your S3 bucket is accessible
- Display your current bucket name, region, and key prefix settings

**Test Results:**
- ✅ **Success**: Shows green message with bucket details
- ❌ **Error**: Shows red message with specific error (credentials, permissions, network)

#### S3 Key Prefix Explanation

The **S3 Key Prefix** organizes your uploaded files in the S3 bucket with a directory structure:

- **Without prefix**: `vessels/self/navigation/position/2025-07-12.parquet`
- **With prefix "marine-data"**: `marine-data/vessels/self/navigation/position/2025-07-12.parquet`  
- **With prefix "boat-123/"**: `boat-123/vessels/self/navigation/position/2025-07-12.parquet`

This allows organizing multiple vessels or data sources in the same S3 bucket.

## API Endpoints

The plugin provides REST API endpoints for programmatic access:

### Query and Data Endpoints

**`GET /plugins/zennora-signalk-parquet/api/paths`**
- Returns all available SignalK paths with Parquet data
- Response: `{ success: true, dataDirectory: "path", paths: [...] }`

**`GET /plugins/zennora-signalk-parquet/api/files/:path`**
- Returns all Parquet files for a specific SignalK path
- Example: `/api/files/navigation.position`
- Response: `{ success: true, path: "...", files: [...] }`

**`GET /plugins/zennora-signalk-parquet/api/sample/:path`**
- Returns sample data from the most recent Parquet file
- Query parameter: `?limit=10` (default: 10 rows)
- Response: `{ success: true, data: [...], columns: [...], rowCount: N }`

**`POST /plugins/zennora-signalk-parquet/api/query`**
- Executes custom DuckDB SQL queries
- Body: `{ "query": "SELECT * FROM 'path/*.parquet' LIMIT 10" }`
- Response: `{ success: true, data: [...], rowCount: N }`

### Management Endpoints

**`POST /plugins/zennora-signalk-parquet/api/test-s3`**
- Tests S3 connection with current configuration
- No body required
- Response: `{ success: true, bucket: "...", region: "...", keyPrefix: "..." }`

**`GET /plugins/zennora-signalk-parquet/api/health`**
- Health check endpoint
- Response: `{ success: true, status: "healthy", duckdb: "available" }`

### Usage Examples

**Query navigation data via API:**
```bash
curl -X POST https://your-signalk-server:3443/plugins/zennora-signalk-parquet/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM \"/home/user/.signalk/data/vessels/self/navigation/position/*.parquet\" LIMIT 5"}'
```

**Test S3 connection:**
```bash
curl -X POST https://your-signalk-server:3443/plugins/zennora-signalk-parquet/api/test-s3
```

**Get available paths:**
```bash
curl https://your-signalk-server:3443/plugins/zennora-signalk-parquet/api/paths
```

## S3 Cloud Backup & Archival

The plugin includes optional S3 integration for cloud backup and long-term archival of Signalk data.

### Features

- **Real-time or Consolidation Upload**: Upload files immediately or only after daily consolidation
- **Flexible Authentication**: Support for IAM roles, environment variables, or direct credentials
- **Directory Structure Preservation**: Maintains the same folder structure in S3
- **Optional Local File Deletion**: Save disk space by removing files after successful upload
- **Error Handling & Retry**: Robust upload with detailed logging

### Configuration

Navigate to SignalK Admin → Server → Plugin Config → Zennora SignalK to Parquet → Configure, then scroll to "S3 Upload Configuration":

#### Basic Settings
- **Enable S3 Upload**: Check to activate S3 functionality
- **Upload Timing**: 
  - *Real-time*: Upload each file immediately after creation (higher S3 costs, immediate backup)
  - *At consolidation*: Upload only consolidated daily files at midnight (lower costs, archival focus)
- **S3 Bucket Name**: Your target S3 bucket
- **AWS Region**: AWS region where bucket is located (default: us-east-1)
- **S3 Key Prefix**: Optional prefix for organization (e.g., "marine-data/")

### Testing S3 Connection

The plugin includes a built-in S3 connection test in the webapp interface:

1. **Navigate to the webapp**: `https://your-signalk-server:3443/plugins/zennora-signalk-parquet/`
2. **Find the "☁️ S3 Configuration" section**
3. **Click "🔗 Test S3 Connection"**

The test will verify:
- ✅ S3 credentials are correctly configured
- ✅ Bucket is accessible with current permissions
- ✅ Network connectivity to AWS S3
- 📋 Display your current bucket, region, and key prefix settings

**What the S3 Key Prefix Does:**
The S3 Key Prefix organizes uploaded files in your bucket with a directory structure:
- **Without prefix**: `vessels/self/navigation/position/2025-07-12.parquet`
- **With prefix "marine-data"**: `marine-data/vessels/self/navigation/position/2025-07-12.parquet`
- **With prefix "boat-123/"**: `boat-123/vessels/self/navigation/position/2025-07-12.parquet`

This allows organizing multiple vessels or data sources in the same S3 bucket.

#### AWS Authentication (Choose One Method)

**Option 1: IAM Roles (Recommended for AWS EC2/ECS)**
```bash
# Leave both credential fields empty in plugin config
# Attach IAM role with S3 permissions to your EC2 instance
```

**Option 2: Environment Variables**
```bash
export AWS_ACCESS_KEY_ID=your_access_key_here
export AWS_SECRET_ACCESS_KEY=your_secret_key_here
# Leave credential fields empty in plugin config
```

**Option 3: AWS Credentials File**
```bash
# Create ~/.aws/credentials file
[default]
aws_access_key_id = your_access_key_here
aws_secret_access_key = your_secret_key_here
# Leave credential fields empty in plugin config
```

**Option 4: Plugin Configuration (Least Secure)**
```bash
# Fill in "AWS Access Key ID" and "AWS Secret Access Key" in plugin config
# Only use if other methods don't work
```

#### Advanced Settings
- **Delete Local Files After Upload**: Remove local files after successful S3 upload to save disk space

### S3 Object Structure

Files are uploaded maintaining the original directory structure:

```
s3://your-bucket/[key-prefix/]vessels/self/navigation/position/signalk_data_20250707_123456.parquet
s3://your-bucket/[key-prefix/]vessels/urn_mrn_imo_mmsi_123456789/navigation/position/signalk_data_2025-07-07_consolidated.parquet
s3://your-bucket/[key-prefix/]vessels/self/environment/wind/speedApparent/signalk_data_2025-07-07_consolidated.parquet
```

### IAM Policy Example

For IAM roles or users, use this S3 policy template:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:PutObjectAcl"
            ],
            "Resource": "arn:aws:s3:::your-bucket-name/*"
        }
    ]
}
```

### Monitoring S3 Uploads

Monitor upload status in SignalK logs:

```bash
journalctl -f -u signalk | grep -E "(S3|Uploaded to S3|Error uploading)"
```

Success messages:
```
✅ Uploaded to S3: s3://your-bucket/vessels/self/navigation/position/signalk_data_20250707_123456.parquet
🗑️ Deleted local file: /path/to/local/file.parquet
```

Error messages:
```
❌ Error uploading /path/to/file.parquet to S3: AccessDenied
```

### Cost Optimization

- **Use consolidation timing** for archival use cases (fewer API calls)
- **Enable file deletion** to minimize local storage costs
- **Set S3 lifecycle policies** to transition old data to cheaper storage classes (IA, Glacier)
- **Use S3 Intelligent Tiering** for automatic cost optimization

### Troubleshooting

**S3 Upload Not Working:**
1. Check AWS credentials are properly configured
2. Verify S3 bucket exists and is accessible
3. Ensure IAM permissions include `s3:PutObject`
4. Check SignalK logs for specific error messages

**High S3 Costs:**
1. Switch from "Real-time" to "At consolidation" timing
2. Enable local file deletion after upload
3. Set up S3 lifecycle policies for automatic archival