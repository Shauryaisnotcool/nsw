const development = process.env.NODE_ENV === 'development';
export default {
  ...(development ? {async rewrites(){return [{source:'/api/:path*',destination:'http://127.0.0.1:8787/api/:path*'}];}} : {output:'export'}),
  trailingSlash:true,
  images:{unoptimized:true},
};
