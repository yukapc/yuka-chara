# Yuka（配信用）

Webサイトに置ける、動くSDキャラ部品。デモ: https://yukapc.github.io/yuka-chara/

## サイトに入れる
```html
<sd-puppet id="yuka" size="300"></sd-puppet>
<script src="https://yukapc.github.io/yuka-chara/sd-puppet.js"></script>
```
- `size` … 表示の高さ（px）
- マウスを目で追う・頭をなでると笑う・放っておくと眠る、は自動

## JavaScript から動かす
```js
const y = document.getElementById('yuka');
y.react('happy');      // 'happy' | 'surprise' | 'shy' | 'nod'
y.talk(1500);          // 1.5秒口パク
y.popAt(button);       // ボタンの後ろからひょこっと出る
```

※ このリポジトリは自動で更新される配信専用です。直接編集しないでください（元データは非公開リポジトリ sd-chara）。
