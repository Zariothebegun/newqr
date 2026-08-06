/* Minimal JAB wasm interface (no emscripten, no PNG/setjmp).
 * Exposes encode/decode using raw RGBA buffers + a tiny result struct.
 */
#include <stdlib.h>
#include <string.h>
#include "jabcode.h"

/* Encode result layout: [0]=width [4]=height [8]=channels [12]=pixel length
 * [16..] = RGBA pixel data. We return a pointer to this buffer.
 * The JS side reads width/height/len and copies pixel bytes.
 */
#define RESULT_HEADER 16

static unsigned char* encode_result = 0;

static unsigned char* make_result(int width, int height, int bpp, const unsigned char* pixels, int pixlen) {
    if (encode_result) { free(encode_result); encode_result = 0; }
    encode_result = (unsigned char*)malloc(RESULT_HEADER + pixlen);
    if (!encode_result) return 0;
    memcpy(encode_result, &width, 4);
    memcpy(encode_result + 4, &height, 4);
    { int ch = bpp / 8; memcpy(encode_result + 8, &ch, 4); }
    memcpy(encode_result + 12, &pixlen, 4);
    if (pixlen) memcpy(encode_result + RESULT_HEADER, pixels, pixlen);
    return encode_result;
}

__attribute__((export_name("encode_image")))
unsigned char* encode_image(char* data_string, int color_number, int symbol_number) {
    jab_int32 length = (jab_int32)strlen(data_string);
    jab_data* data = (jab_data*)malloc(sizeof(jab_data) + (length ? length : 1));
    if (!data) return 0;
    data->length = length;
    memcpy(data->data, data_string, length);

    jab_encode* enc = createEncode(color_number, symbol_number);
    generateJABCode(enc, data);

    jab_bitmap* bitmap = enc->bitmap;
    int width = bitmap->width;
    int height = bitmap->height;
    int bytes_per_pixel = bitmap->bits_per_pixel / 8;
    int pixlen = width * height * bytes_per_pixel;

    unsigned char* result = make_result(width, height, bitmap->bits_per_pixel,
                                         bitmap->pixel, pixlen);
    destroyEncode(enc);
    free(data);
    return result;
}

__attribute__((export_name("decode_image")))
/* pixels: RGBA8, length bytes; returns result buffer with [w,h,ch,len, RGBA] or 0 */
unsigned char* decode_image(unsigned char* rgba, int width, int height) {
    jab_bitmap* bitmap = (jab_bitmap*)malloc(sizeof(jab_bitmap) + (size_t)width * height * 4);
    if (!bitmap) return 0;
    bitmap->height = height;
    bitmap->width = width;
    bitmap->bits_per_channel = BITMAP_BITS_PER_CHANNEL;
    bitmap->bits_per_pixel = BITMAP_BITS_PER_PIXEL;
    bitmap->channel_count = BITMAP_CHANNEL_COUNT;
    memcpy(bitmap->pixel, rgba, (size_t)width * height * 4);

    jab_int32 mode;
    jab_int32 status;
    jab_decoded_symbol symbols[MAX_SYMBOL_NUMBER];
    jab_data* data = decodeJABCodeEx(bitmap, mode, &status, symbols, MAX_SYMBOL_NUMBER);
    free(bitmap);
    if (!data) return 0;

    /* return data bytes with header: [len(4)][data] */
    if (encode_result) { free(encode_result); encode_result = 0; }
    encode_result = (unsigned char*)malloc(RESULT_HEADER + data->length);
    if (!encode_result) { free(data); return 0; }
    memset(encode_result, 0, RESULT_HEADER);
    memcpy(encode_result, &data->length, 4);
    memcpy(encode_result + RESULT_HEADER, data->data, data->length);
    free(data);
    return encode_result;
}

__attribute__((export_name("getDefaultSymbolNumber")))
int getDefaultSymbolNumber(void) {
    return MAX_SYMBOL_NUMBER;
}
__attribute__((export_name("getDefaultColorNumber")))
int getDefaultColorNumber(void) {
    return MAX_COLOR_NUMBER;
}
