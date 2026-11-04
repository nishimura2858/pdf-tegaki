/* Google連携の設定値。
   どれもブラウザに送られる公開前提の値で、Google Cloud側で使える場所を制限しています。
   （クライアントシークレットは使わないので、ここには書かないこと） */
window.APP_CONFIG = {
  // OAuthクライアントID（承認済みの生成元: nishimura2858.github.io / localhost:8000）
  CLIENT_ID: '519206114844-hu35q7mhj8bgakg8a7pq0aub40un4oh3.apps.googleusercontent.com',
  // APIキー（Google Picker APIのみ、上記2サイトからのみ使用可）
  API_KEY: 'AIzaSyA9Eg71Y5a9V4ZR5Y5rlglYWpGUA1b-oas',
  // プロジェクト番号（PickerのappIdに使う）
  APP_ID: '519206114844',
  // Drive全体（元のPDFに書き込みを反映するため。Google Cloud の「データアクセス」にも同じものを登録）
  SCOPE: 'https://www.googleapis.com/auth/drive'
};
