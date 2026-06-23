import Dexie from 'dexie';

// Initialize the local Dexie database
export const db = new Dexie('IPTVPlayerZeroDB');

// Define tables and indexes. 
// We only specify properties we need to query/filter by.
db.version(2).stores({
  live_categories: 'category_id',
  vod_categories: 'category_id',
  series_categories: 'category_id',
  
  live_streams: 'stream_id, category_id',
  vod_streams: 'stream_id, category_id',
  series_streams: 'series_id, category_id',
  
  favorites: '[type+id], type, id', // Composite primary key to uniquely map a favorite item
  recently_viewed: 'id, timestamp'
});
