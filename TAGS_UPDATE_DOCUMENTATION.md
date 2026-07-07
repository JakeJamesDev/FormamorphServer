# Tags Update Documentation

## Issue Overview

There was an issue with the tags field not being properly included when publishing worlds to the server. Previously, tags were obtained from `worldOverview.tags`, but a recent update reversed that, causing new worlds to miss tags information.

## Changes Made

### 1. Created Utility Script to Update Tags

Created a utility script (`src/utils/updateWorldTags.js`) that:
- Fetches all worlds from the database
- For each world, reads its content file to extract `worldOverview.tags`
- Updates the world's tags in the database with the extracted tags

### 2. Fixed World Controller Endpoints

Modified the world controller endpoints to properly extract tags from multiple possible sources:

#### In `createWorld` function:
- Now extracts tags from `contentData.worldOverview.tags` (preferred source)
- Falls back to `worldOverview.tags` if available
- Finally uses direct `tags` field if provided

#### In `updateWorld` function:
- Now extracts tags from `contentData.worldOverview.tags` (preferred source)
- Falls back to `worldOverview.tags` if available
- Finally uses direct `tags` field if provided

### 3. Added NPM Script

Added a new script to package.json to easily run the tags update utility:
```
npm run update-tags
```

## How to Use

### Running the Tags Update Utility

To update tags for all existing worlds in the database:

```bash
npm run update-tags
```

This will:
1. Scan all worlds in the database
2. Extract tags from each world's content file
3. Update the database with the correct tags
4. Log the results of the operation

### Expected Output

When running the utility, you'll see output similar to:

```
Starting world tags update process...
Found X worlds to process
Processing world: [world-id]
Updated tags for world [world-id]: ["tag1","tag2"]
...
World tags update completed:
- Total worlds processed: X
- Updated: Y
- Skipped: Z
- Errors: 0
World tags update script completed successfully
```

## Verification

After running the utility and deploying the code changes, you can verify the fix by:

1. Creating a new world with tags in the client
2. Publishing the world to the server
3. Verifying the tags are visible in the published world details
4. Updating the world with new tags
5. Verifying the updated tags are reflected in the published world

## Technical Details

### Tag Extraction Logic

The system now tries to extract tags in the following order of preference:

1. From `contentData.worldOverview.tags` (most preferred)
2. From `worldOverview.tags` (fallback)
3. From direct `tags` field (least preferred)

This ensures backward compatibility with different client implementations while prioritizing the most accurate source of tag information.

### Tag Storage

Tags are stored in the database as a JSON string representation of an array. When retrieved, they are parsed back into an array for use in the application.
