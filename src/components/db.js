import Dexie from 'dexie';

// Initialize the local Dexie database
export const db = new Dexie('IPTVPlayerZeroDB');

// Define tables and indexes. 
// We only specify properties we need to query/filter by.
db.version(1).stores({
  live_categories: 'category_id, category_name',
  vod_categories: 'category_id, category_name',
  series_categories: 'category_id, category_name',
  
  live_streams: 'stream_id, category_id, name',
  vod_streams: 'stream_id, category_id, name, rating, year',
  series_streams: 'series_id, category_id, name, rating, releaseDate',
  
  favorites: '[type+id], type, id', // Composite primary key to uniquely map a favorite item
  recently_viewed: 'id, timestamp'
});
